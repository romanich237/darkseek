const { createServer } = require('node:http');
const { DatabaseSync } = require('node:sqlite');
const { readFileSync, mkdirSync, readdirSync } = require('node:fs');
const { resolve, dirname, join } = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const config = require('./config.json');

async function start() {
  const filename = resolve(__dirname, config.database);
  mkdirSync(dirname(filename), { recursive: true });
  const sqlite = new DatabaseSync(filename);
  sqlite.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000');
  sqlite.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY)');
  for (const name of readdirSync(join(__dirname, 'migrations')).filter(name => name.endsWith('.sql')).sort()) {
    if (sqlite.prepare('SELECT name FROM schema_migrations WHERE name = ?').get(name)) continue;
    sqlite.exec('BEGIN IMMEDIATE');
    try {
      sqlite.exec(readFileSync(join(__dirname, 'migrations', name), 'utf8'));
      sqlite.prepare('INSERT INTO schema_migrations VALUES (?)').run(name);
      sqlite.exec('COMMIT');
    } catch (error) {
      sqlite.exec('ROLLBACK');
      throw error;
    }
  }
  // Keep synchronous SQLite statements inside one transaction without await boundaries.
  const wrap = (sql, args = []) => ({
    bind: (...values) => wrap(sql, values),
    first: () => sqlite.prepare(sql).get(...args) ?? null,
    all: () => ({ results: sqlite.prepare(sql).all(...args) }),
    run: () => sqlite.prepare(sql).run(...args),
    execute: () => sqlite.prepare(sql).run(...args),
  });
  const db = {
    prepare: sql => wrap(sql),
    batch(statements) {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const results = statements.map(statement => statement.execute());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
  const assets = new Map();
  const types = {
    'index.html': 'text/html; charset=utf-8',
    'app.js': 'text/javascript; charset=utf-8',
    'style.css': 'text/css; charset=utf-8',
    'logo.png': 'image/png',
  };
  for (const [name, type] of Object.entries(types)) {
    assets.set('/' + name, { type, body: readFileSync(join(__dirname, 'public', name)) });
  }
  assets.set('/', assets.get('/index.html'));
  const { default: api } = await import('./api.mjs');
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://' + req.headers.host);
      if (!url.pathname.startsWith('/api/')) {
        const asset = assets.get(url.pathname);
        if (!asset) { res.writeHead(404).end(); return; }
        if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405).end(); return; }
        res.writeHead(200, { 'content-type': asset.type, 'x-content-type-options': 'nosniff' });
        res.end(req.method === 'HEAD' ? undefined : asset.body);
        return;
      }
      const init = { method: req.method, headers: req.headers };
      if (!['GET', 'HEAD'].includes(req.method)) {
        init.body = Readable.toWeb(req);
        init.duplex = 'half';
      }
      const response = await api.fetch(new Request(url, init), {
        DB: db,
        clientIp: req.socket.remoteAddress,
      });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) await pipeline(Readable.fromWeb(response.body), res);
      else res.end();
    } catch (error) {
      console.error('Request failed', error.message);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"error":"unavailable"}');
    }
  });
  server.listen(config.port, config.host, () => {
    console.log(`Darkseek: http://${config.host}:${config.port}`);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => server.close(() => { sqlite.close(); process.exit(0); }));
  }
}
start().catch(error => { console.error(error.message); process.exitCode = 1; });
