export async function database(db, operation, tokenHash, payload, ip) {
  const query = (sql, ...args) => db.prepare(sql).bind(...args);
  const now = Date.now();
  if (operation === 'create' || operation === 'login') {
    const expiry = Math.floor(now / 60000) * 60000 + 60000;
    const limit = await query(
      'INSERT INTO auth_limits VALUES (?, 1, ?) ON CONFLICT(bucket) DO UPDATE SET hits = hits + 1 WHERE hits < 12 RETURNING hits',
      ip + ':' + expiry, expiry,
    ).first();
    if (!limit) return { error: 'rate' };
    let profile;
    if (operation === 'create') {
      const id = crypto.randomUUID();
      const publicId = 'shade_' + id.replaceAll('-', '');
      await db.batch([
        query('INSERT INTO profiles VALUES (?, ?, ?)', id, publicId, payload.key_hash),
        query('INSERT INTO sessions VALUES (?, ?, ?)', tokenHash, id, now + 604800000),
        query('DELETE FROM auth_limits WHERE expires_at <= ?', now),
      ]);
      return { publicId };
    }
    profile = await query('SELECT id, public_id FROM profiles WHERE key_hash = ?', payload.key_hash).first();
    if (!profile) return { error: 'unauthorized' };
    await db.batch([
      query('DELETE FROM sessions WHERE profile_id = ? AND expires_at <= ?', profile.id, now),
      query('INSERT INTO sessions VALUES (?, ?, ?)', tokenHash, profile.id, now + 604800000),
      query('DELETE FROM auth_limits WHERE expires_at <= ?', now),
    ]);
    return { publicId: profile.public_id };
  }

  const me = await query(
    'SELECT p.id, p.public_id FROM profiles p JOIN sessions s ON s.profile_id = p.id WHERE s.token_hash = ? AND s.expires_at > ?',
    tokenHash, now,
  ).first();
  if (!me) return { error: 'unauthorized' };
  if (operation === 'profile') return { publicId: me.public_id };
  if (operation === 'logout') {
    await query('DELETE FROM sessions WHERE token_hash = ?', tokenHash).run();
    return {};
  }
  if (operation === 'dialogs') {
    const { results } = await query(`
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
    const peer = await query('SELECT id FROM profiles WHERE public_id = ? AND id <> ?', payload.peer, me.id).first();
    if (!peer) return { error: 'missing' };
    const [first, second] = [me.id, peer.id].sort();
    return query(`
      INSERT INTO dialogs VALUES (?, ?, ?)
      ON CONFLICT(first_id, second_id) DO UPDATE SET first_id = excluded.first_id
      RETURNING id
    `, crypto.randomUUID(), first, second).first();
  }

  const dialog = await query('SELECT id FROM dialogs WHERE id = ? AND (first_id = ? OR second_id = ?)',
    payload.id, me.id, me.id).first();
  if (!dialog) return { error: 'missing' };
  if (operation === 'send') {
    const inserted = await query(`
      INSERT INTO messages VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING RETURNING id
    `, payload.messageId, dialog.id, me.id, payload.text, now).first();
    if (inserted) return {};
    const existing = await query(
      'SELECT id FROM messages WHERE id = ? AND dialog_id = ? AND sender_id = ? AND body = ?',
      payload.messageId, dialog.id, me.id, payload.text,
    ).first();
    return existing ? {} : { error: 'conflict' };
  }
  const { results } = await query(`
    SELECT sender_id, body, sent_at FROM messages
    WHERE dialog_id = ? ORDER BY sent_at DESC, id DESC LIMIT 100
  `, dialog.id).all();
  return { messages: results.reverse().map(row => ({
    mine: row.sender_id === me.id, text: row.body, sentAt: new Date(row.sent_at).toISOString(),
  })) };
}
