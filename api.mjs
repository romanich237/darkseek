import { database } from './database.mjs';

const cookieName = 'darkseek_session';
const sessionAge = 604800;
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const operations = new Set(['create', 'login', 'logout', 'profile', 'dialogs', 'open', 'history', 'send']);
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const encoder = new TextEncoder();
const hex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
const hash = async value => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));

function reply(data, status = 200, cookie) {
  const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
  if (cookie !== undefined) {
    headers['set-cookie'] = `${cookieName}=${cookie}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${cookie ? sessionAge : 0}`;
  }
  return Response.json(data, { status, headers });
}

async function readPayload(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Missing body');
  const decoder = new TextDecoder();
  let bytes = 0;
  let json = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > 4096) {
      await reader.cancel();
      throw new Error('Body too large');
    }
    json += decoder.decode(value, { stream: true });
  }
  const payload = JSON.parse(json + decoder.decode());
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid body');
  return payload;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    const operation = url.pathname.slice(5);
    if (!operations.has(operation)) return reply({ error: 'missing' }, 404);
    if (request.method !== 'POST') return reply({ error: 'method' }, 405);
    if (request.headers.get('origin') !== url.origin) return reply({ error: 'origin' }, 403);
    const auth = operation === 'login' || operation === 'create';
    const ip = env.clientIp;
    let input;
    try {
      input = await readPayload(request);
    } catch {
      return reply({ error: 'invalid' }, 400);
    }
    const payload = {};
    let key;
    let token = request.headers.get('cookie')?.match(/(?:^|;\s*)darkseek_session=([0-9a-f]{64})(?:;|$)/)?.[1];

    if (auth) {
      key = operation === 'create'
        ? Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => alphabet[byte & 31]).join('')
        : input.key;
      if (typeof key !== 'string' || !/^[A-HJ-NP-Z2-9]{16}$/.test(key)) return reply({ error: 'invalid' }, 400);
      payload.key_hash = await hash(key);
      token = hex(crypto.getRandomValues(new Uint8Array(32)));
    }
    if (!token) return reply({ error: 'unauthorized' }, 401);

    if (operation === 'open') {
      if (typeof input.peer !== 'string' || !/^shade_[a-f0-9]{32}$/.test(input.peer)) return reply({ error: 'invalid' }, 400);
      payload.peer = input.peer;
    }
    if (operation === 'history' || operation === 'send') {
      if (typeof input.id !== 'string' || !uuid.test(input.id)) return reply({ error: 'invalid' }, 400);
      payload.id = input.id;
    }
    if (operation === 'send') {
      if (typeof input.messageId !== 'string' || !uuid.test(input.messageId) ||
          typeof input.text !== 'string' || !input.text.trim() || input.text.length > 500 || input.text.includes('\0')) {
        return reply({ error: 'invalid' }, 400);
      }
      payload.text = input.text.trim();
      payload.messageId = input.messageId;
    }

    try {
      const data = await database(env.DB, operation, await hash(token), payload, auth ? await hash(ip) : '');
      if (data.error) {
        const status = { invalid: 400, unauthorized: 401, missing: 404, conflict: 409, rate: 429 }[data.error];
        return reply(data, status ?? 503, status === 401 && !auth ? '' : undefined);
      }
      if (operation === 'create') data.key = key;
      return reply(data, 200, auth ? token : operation === 'logout' ? '' : undefined);
    } catch {
      return reply({ error: 'unavailable' }, 503);
    }
  },
};
