/**
 * Market server — authoritative data layer.
 *
 * Everything that must be SHARED between people lives here and nowhere else:
 * accounts, groups, grants, sessions, device authorizations, the plugin catalog,
 * artifact bytes, and the audit log. The DSH-side plugin holds no accounts and
 * makes no authorization decisions of its own.
 *
 * Storage: node:sqlite (built into Node >= 22.5), so the service has no runtime
 * dependencies at all.
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/** Effective status of an artifact row. */
export const ARTIFACT_STATES = ['draft', 'review', 'published', 'revoked']

export function openDatabase(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db)
  return db
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id                   TEXT PRIMARY KEY,
      username             TEXT NOT NULL UNIQUE,
      display_name         TEXT NOT NULL,
      role                 TEXT NOT NULL DEFAULT 'member',
      status               TEXT NOT NULL DEFAULT 'active',
      password_hash        TEXT NOT NULL,
      must_change_password INTEGER NOT NULL DEFAULT 1,
      failed_logins        INTEGER NOT NULL DEFAULT 0,
      locked_until         INTEGER,
      created_at           INTEGER NOT NULL,
      created_by           TEXT NOT NULL DEFAULT 'system',
      password_changed_at  INTEGER,
      last_login_at        INTEGER
    );

    CREATE TABLE IF NOT EXISTS groups (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      created_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memberships (
      username   TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
      group_id   TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (username, group_id)
    );

    CREATE TABLE IF NOT EXISTS grants (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id       TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      plugin_pattern TEXT NOT NULL,
      effect         TEXT NOT NULL DEFAULT 'allow',
      channel        TEXT,
      created_at     INTEGER NOT NULL,
      created_by     TEXT NOT NULL DEFAULT 'system'
    );
    CREATE INDEX IF NOT EXISTS grants_group ON grants(group_id);

    CREATE TABLE IF NOT EXISTS sessions (
      id                 TEXT PRIMARY KEY,
      user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      username           TEXT NOT NULL,
      token_hash         TEXT NOT NULL UNIQUE,
      refresh_hash       TEXT NOT NULL,
      issued_at          INTEGER NOT NULL,
      expires_at         INTEGER NOT NULL,
      refresh_expires_at INTEGER NOT NULL,
      revoked_at         INTEGER,
      ip                 TEXT,
      user_agent         TEXT
    );
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);


    /**
     * DSH account <-> market account, strictly one to one.
     *
     * Decided by the operator: 「一个 DSH 账号只能绑一个市场账号」. Both directions are
     * therefore unique, so a DSH account cannot acquire a second market identity and
     * a market account cannot be claimed by a second DSH account. Making only
     * dsh_user_id unique would let one market account serve many people, which is
     * not what was asked for.
     *
     * dsh_name is a denormalised display hint so the console can show something
     * human without a network round trip. It is never used for a decision.
     *
     * NOTE: this comment lives inside a template literal, so it must not contain a
     * backtick — one did, and it terminated the SQL string early.
     */
    CREATE TABLE IF NOT EXISTS dsh_bindings (
      dsh_user_id     TEXT PRIMARY KEY,
      market_username TEXT NOT NULL UNIQUE REFERENCES users(username) ON DELETE CASCADE,
      dsh_name        TEXT NOT NULL DEFAULT '',
      device_id       TEXT,
      bound_at        INTEGER NOT NULL,
      bound_by        TEXT NOT NULL DEFAULT 'system',
      bound_ip        TEXT
    );
    CREATE INDEX IF NOT EXISTS dsh_bindings_market ON dsh_bindings(market_username);

    CREATE TABLE IF NOT EXISTS artifacts (
      name         TEXT NOT NULL,
      version      TEXT NOT NULL,
      channel      TEXT NOT NULL DEFAULT 'stable',
      state        TEXT NOT NULL DEFAULT 'published',
      owner        TEXT NOT NULL DEFAULT '',
      summary      TEXT NOT NULL DEFAULT '',
      dsh_range    TEXT NOT NULL DEFAULT '',
      permissions  TEXT NOT NULL DEFAULT '[]',
      sha256       TEXT NOT NULL,
      size_bytes   INTEGER NOT NULL,
      stored_path  TEXT NOT NULL,
      published_at INTEGER NOT NULL,
      published_by TEXT NOT NULL DEFAULT 'system',
      PRIMARY KEY (name, version, channel)
    );
    CREATE INDEX IF NOT EXISTS artifacts_name ON artifacts(name);

    CREATE TABLE IF NOT EXISTS audit (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      at         INTEGER NOT NULL,
      action     TEXT NOT NULL,
      username   TEXT,
      detail     TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS audit_at ON audit(at);

    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)

  /**
   * Additive migration for databases that already exist.
   *
   * `CREATE TABLE IF NOT EXISTS` does nothing to a table that is already there, so a new
   * column needs an explicit ALTER. Guarded by `PRAGMA table_info` because SQLite has no
   * `ADD COLUMN IF NOT EXISTS`, and this runs on every boot.
   */
  const columns = db.prepare('PRAGMA table_info(dsh_bindings)').all()
  if (!columns.some((row) => row.name === 'secret_hash')) {
    db.exec('ALTER TABLE dsh_bindings ADD COLUMN secret_hash TEXT')
  }
}

/** Rows -> plain objects with the field names the HTTP layer speaks. */
export function rowToUser(row) {
  if (!row) return null
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    status: row.status,
    mustChangePassword: row.must_change_password === 1,
    failedLogins: row.failed_logins,
    lockedUntil: row.locked_until,
    createdAt: row.created_at,
    createdBy: row.created_by,
    passwordChangedAt: row.password_changed_at,
    lastLoginAt: row.last_login_at,
  }
}

export function rowToArtifact(row) {
  if (!row) return null
  let permissions = []
  try {
    permissions = JSON.parse(row.permissions)
  } catch {
    permissions = []
  }
  return {
    name: row.name,
    version: row.version,
    channel: row.channel,
    status: row.state,
    owner: row.owner,
    summary: row.summary,
    dsh: row.dsh_range || null,
    permissions,
    sha256: row.sha256,
    sizeBytes: row.size_bytes,
    publishedAt: row.published_at,
    publishedBy: row.published_by,
  }
}
