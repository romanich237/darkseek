const { DatabaseSync } = require('node:sqlite');
const { existsSync, mkdirSync } = require('node:fs');
const { dirname, resolve } = require('node:path');

function openDatabase(filename) {
  mkdirSync(dirname(filename), { recursive: true });
  const previous = resolve(__dirname, 'data/darkseek.sqlite');
  if (!existsSync(filename) && filename === resolve(__dirname, 'users.db') && existsSync(previous)) {
    const old = new DatabaseSync(previous);
    try {
      old.prepare('VACUUM INTO ?').run(filename);
    } finally {
      old.close();
    }
  }
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = DELETE; PRAGMA foreign_keys = ON');
  db.exec(`CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  key_hash TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_profile ON sessions(profile_id, expires_at);
CREATE TABLE IF NOT EXISTS dialogs (
  id TEXT PRIMARY KEY,
  first_id TEXT NOT NULL REFERENCES profiles(id),
  second_id TEXT NOT NULL REFERENCES profiles(id),
  CHECK(first_id < second_id),
  UNIQUE(first_id, second_id)
);
CREATE INDEX IF NOT EXISTS dialogs_second ON dialogs(second_id);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  dialog_id TEXT NOT NULL REFERENCES dialogs(id),
  sender_id TEXT NOT NULL REFERENCES profiles(id),
  body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 500),
  sent_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_recent ON messages(dialog_id, sent_at DESC, id DESC);
CREATE TABLE IF NOT EXISTS auth_limits (
  bucket TEXT PRIMARY KEY,
  hits INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_limits_expiry ON auth_limits(expires_at);
`);
  return db;
}

function database(db, operation, tokenHash, payload, ip) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = execute(db, operation, tokenHash, payload, ip);
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function execute(db, operation, tokenHash, payload, ip) {
  const query = (sql, ...args) => ({
    first: () => db.prepare(sql).get(...args),
    all: () => db.prepare(sql).all(...args),
    run: () => db.prepare(sql).run(...args),
  });
  const now = Date.now();
  if (operation === 'create' || operation === 'login') {
    const expiry = Math.floor(now / 60000) * 60000 + 60000;
    const limit = query(
      'INSERT INTO auth_limits VALUES (?, 1, ?) ON CONFLICT(bucket) DO UPDATE SET hits = hits + 1 WHERE hits < 12 RETURNING hits',
      ip + ':' + expiry, expiry,
    ).first();
    if (!limit) return { error: 'rate' };
    if (operation === 'create') {
      const id = crypto.randomUUID();
      const publicId = 'shade_' + id.replaceAll('-', '');
      query('INSERT INTO profiles VALUES (?, ?, ?)', id, publicId, payload.key_hash).run();
      query('INSERT INTO sessions VALUES (?, ?, ?)', tokenHash, id, now + 604800000).run();
      query('DELETE FROM auth_limits WHERE expires_at <= ?', now).run();

      return { publicId };
    }
    const profile = query('SELECT id, public_id FROM profiles WHERE key_hash = ?', payload.key_hash).first();
    if (!profile) return { error: 'unauthorized' };

      query('DELETE FROM sessions WHERE profile_id = ? AND expires_at <= ?', profile.id, now).run();
      query('INSERT INTO sessions VALUES (?, ?, ?)', tokenHash, profile.id, now + 604800000).run();
      query('DELETE FROM auth_limits WHERE expires_at <= ?', now).run();

    return { publicId: profile.public_id };
  }

  const me = query(
    'SELECT p.id, p.public_id FROM profiles p JOIN sessions s ON s.profile_id = p.id WHERE s.token_hash = ? AND s.expires_at > ?',
    tokenHash, now,
  ).first();
  if (!me) return { error: 'unauthorized' };
  if (operation === 'profile') return { publicId: me.public_id };
  if (operation === 'logout') {
    query('DELETE FROM sessions WHERE token_hash = ?', tokenHash).run();
    return {};
  }
  if (operation === 'dialogs') {
    const results = query(`
      SELECT d.id, p.public_id AS peer, m.body AS preview
      FROM dialogs d
      JOIN profiles p ON p.id = CASE WHEN d.first_id = ? THEN d.second_id ELSE d.first_id END
      LEFT JOIN messages m ON m.id = (
        SELECT id FROM messages WHERE dialog_id = d.id ORDER BY sent_at DESC, id DESC LIMIT 1
      )
      WHERE d.first_id = ? OR d.second_id = ?
      ORDER BY m.sent_at DESC, p.public_id
    `, me.id, me.id, me.id).all();
    return { dialogs: results };
  }
  if (operation === 'open') {
    const peer = query('SELECT id FROM profiles WHERE public_id = ? AND id <> ?', payload.peer, me.id).first();
    if (!peer) return { error: 'missing' };
    const [first, second] = [me.id, peer.id].sort();
    return query(`
      INSERT INTO dialogs VALUES (?, ?, ?)
      ON CONFLICT(first_id, second_id) DO UPDATE SET first_id = excluded.first_id
      RETURNING id
    `, crypto.randomUUID(), first, second).first();
  }

  const dialog = query('SELECT id FROM dialogs WHERE id = ? AND (first_id = ? OR second_id = ?)',
    payload.id, me.id, me.id).first();
  if (!dialog) return { error: 'missing' };
  if (operation === 'send') {
    const inserted = query(`
      INSERT INTO messages VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING RETURNING id
    `, payload.messageId, dialog.id, me.id, payload.text, now).first();
    if (inserted) return {};
    const existing = query(
      'SELECT id FROM messages WHERE id = ? AND dialog_id = ? AND sender_id = ? AND body = ?',
      payload.messageId, dialog.id, me.id, payload.text,
    ).first();
    return existing ? {} : { error: 'conflict' };
  }
  const results = query(`
    SELECT sender_id, body, sent_at FROM messages
    WHERE dialog_id = ? ORDER BY sent_at DESC, id DESC LIMIT 100
  `, dialog.id).all();
  return { messages: results.reverse().map(row => ({
    mine: row.sender_id === me.id, text: row.body, sentAt: new Date(row.sent_at).toISOString(),
  })) };
}

module.exports = { openDatabase, database };
