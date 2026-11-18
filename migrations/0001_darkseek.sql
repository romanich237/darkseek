CREATE TABLE profiles (
  id TEXT PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  key_hash TEXT NOT NULL UNIQUE
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_profile ON sessions(profile_id, expires_at);
CREATE TABLE dialogs (
  id TEXT PRIMARY KEY,
  first_id TEXT NOT NULL REFERENCES profiles(id),
  second_id TEXT NOT NULL REFERENCES profiles(id),
  CHECK(first_id < second_id),
  UNIQUE(first_id, second_id)
);
CREATE INDEX dialogs_second ON dialogs(second_id);
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  dialog_id TEXT NOT NULL REFERENCES dialogs(id),
  sender_id TEXT NOT NULL REFERENCES profiles(id),
  body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 500),
  sent_at INTEGER NOT NULL
);
CREATE INDEX messages_recent ON messages(dialog_id, sent_at DESC, id DESC);
CREATE TABLE auth_limits (
  bucket TEXT PRIMARY KEY,
  hits INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX auth_limits_expiry ON auth_limits(expires_at);
