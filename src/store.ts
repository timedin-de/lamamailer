// All persistent state lives in one SQLite file (node:sqlite, built into Node): the signup queue,
// key/value data (settings, watermark, admin password hash) and login sessions.
// Nothing important is kept in memory, so the process can be killed and restarted at any time.
import { DatabaseSync } from 'node:sqlite';

export type Status = 'pending' | 'sending' | 'sent' | 'failed' | 'skipped';

/** Everything the mail needs, stored as JSON with the signup (decoded at poll time). */
export interface SignupFields {
  answers?: { label: string; value: string }[];
  fields?: Record<string, string>;
  firstName?: string;
  lastName?: string;
}

export interface Signup {
  id: number;
  key: string;
  email: string;
  name: string;
  fields: SignupFields;
  status: Status;
  attempts: number;
  nextTryAt: number;
  sendingSince: number;
  createdAt: number;
  sentAt: number;
  error: string;
}

export interface NewSignup {
  key: string; // one LamaPoll submission = one key (NOT the email)
  email: string;
  name: string;
  fields: SignupFields;
  status: 'pending' | 'skipped' | 'failed';
  error?: string;
}

/** How long a row may stay in "sending" before the UI asks a human to check it. */
export const STALE_SENDING_MS = 2 * 60_000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS signups (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  key           TEXT NOT NULL UNIQUE,
  email         TEXT NOT NULL,
  name          TEXT NOT NULL DEFAULT '',
  fields_json   TEXT NOT NULL DEFAULT '{}',
  status        TEXT NOT NULL CHECK (status IN ('pending','sending','sent','failed','skipped')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  next_try_at   INTEGER NOT NULL DEFAULT 0,
  sending_since INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  sent_at       INTEGER NOT NULL DEFAULT 0,
  error         TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS signups_status ON signups(status, next_try_at);
CREATE INDEX IF NOT EXISTS signups_email ON signups(email, sent_at);
`;

const COLS = 'id, key, email, name, fields_json, status, attempts, next_try_at, sending_since, created_at, sent_at, error';

type Row = Record<string, string | number | null>;

function toSignup(r: Row): Signup {
  return {
    id: Number(r.id), key: String(r.key), email: String(r.email), name: String(r.name),
    fields: JSON.parse(String(r.fields_json)) as SignupFields, status: r.status as Status,
    attempts: Number(r.attempts), nextTryAt: Number(r.next_try_at), sendingSince: Number(r.sending_since),
    createdAt: Number(r.created_at), sentAt: Number(r.sent_at), error: String(r.error),
  };
}

export class Store {
  #db: DatabaseSync;

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    // WAL = durable and fast; busy_timeout avoids "database is locked" errors.
    this.#db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
    this.#db.exec(SCHEMA);
  }

  close(): void { this.#db.close(); }

  /** Runs fn inside one transaction: everything is stored, or nothing. */
  #tx<T>(fn: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.#db.exec('COMMIT');
      return result;
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
  }

  // ---- key/value ----

  getKv(key: string): string | null {
    const r = this.#db.prepare('SELECT v FROM kv WHERE k = ?').get(key) as Row | undefined;
    return r ? String(r.v) : null;
  }

  setKv(key: string, value: string): void {
    this.#db.prepare('INSERT INTO kv(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(key, value);
  }

  /** Start time (ms) of the last successful poll, or null. */
  watermark(): number | null {
    const v = this.getKv('watermark');
    return v === null ? null : Number(v);
  }

  firstRunDone(): boolean { return this.getKv('first_run_done') === '1'; }

  // ---- queue ----

  /**
   * Inserts new submissions and advances the watermark in ONE transaction. Known keys are ignored,
   * which makes re-polling (overlap) harmless. Returns how many rows were really new.
   */
  addSignups(items: NewSignup[], watermarkMs: number, nowMs: number): number {
    return this.#tx(() => {
      const insert = this.#db.prepare(
        `INSERT INTO signups(key, email, name, fields_json, status, error, created_at)
         VALUES(?, ?, ?, ?, ?, ?, ?) ON CONFLICT(key) DO NOTHING`);
      let added = 0;
      for (const it of items) {
        const res = insert.run(it.key, it.email, it.name, JSON.stringify(it.fields), it.status, it.error ?? '', nowMs);
        added += Number(res.changes);
      }
      this.setKv('watermark', String(watermarkMs));
      this.setKv('first_run_done', '1');
      return added;
    });
  }

  /**
   * Atomically takes the oldest due pending row and marks it "sending". Rows already in "sending"
   * (e.g. left over from a crash) are never claimed again: we cannot know whether their mail went
   * out, so a human decides in the admin UI.
   */
  claim(nowMs: number): Signup | null {
    const r = this.#db.prepare(
      `UPDATE signups SET status = 'sending', sending_since = ?, attempts = attempts + 1
       WHERE id = (SELECT id FROM signups WHERE status = 'pending' AND next_try_at <= ? ORDER BY id LIMIT 1)
       RETURNING ${COLS}`).get(nowMs, nowMs) as Row | undefined;
    return r ? toSignup(r) : null;
  }

  markSent(id: number, nowMs: number): void {
    this.#db.prepare("UPDATE signups SET status = 'sent', sent_at = ?, error = '' WHERE id = ?").run(nowMs, id);
  }

  markRetry(id: number, nextMs: number, error: string): void {
    this.#db.prepare("UPDATE signups SET status = 'pending', next_try_at = ?, error = ? WHERE id = ?").run(nextMs, error, id);
  }

  markFinal(id: number, status: 'failed' | 'skipped', error: string): void {
    this.#db.prepare('UPDATE signups SET status = ?, error = ? WHERE id = ?').run(status, error, id);
  }

  /** Manual "try again". Sent rows are left alone, so a click can never cause a duplicate mail. */
  requeue(id: number): void {
    this.#db.prepare(
      `UPDATE signups SET status = 'pending', attempts = 0, next_try_at = 0, error = ''
       WHERE id = ? AND status IN ('failed', 'skipped', 'sending')`).run(id);
  }

  /** Admin confirms that a stuck "sending" row was in fact delivered. */
  forceSent(id: number, nowMs: number): void {
    this.#db.prepare("UPDATE signups SET status = 'sent', sent_at = ?, error = 'confirmed manually' WHERE id = ? AND status = 'sending'").run(nowMs, id);
  }

  isStale(s: Signup, nowMs: number): boolean {
    return s.status === 'sending' && nowMs - s.sendingSince > STALE_SENDING_MS;
  }

  /** Mails to one address since sinceMs (for the per-address cap); a row being sent counts too. */
  sentSince(email: string, sinceMs: number): number {
    const r = this.#db.prepare(
      `SELECT COUNT(*) AS n FROM signups WHERE email = ?
       AND ((status = 'sent' AND sent_at >= ?) OR (status = 'sending' AND sending_since >= ?))`).get(email, sinceMs, sinceMs) as Row;
    return Number(r.n);
  }

  counts(): Record<string, number> {
    const rows = this.#db.prepare('SELECT status, COUNT(*) AS n FROM signups GROUP BY status').all() as Row[];
    return Object.fromEntries(rows.map((r) => [String(r.status), Number(r.n)]));
  }

  /** Newest rows first, optionally filtered by status ('' = all). */
  list(status: string, limit: number): Signup[] {
    const rows = (status
      ? this.#db.prepare(`SELECT ${COLS} FROM signups WHERE status = ? ORDER BY id DESC LIMIT ?`).all(status, limit)
      : this.#db.prepare(`SELECT ${COLS} FROM signups ORDER BY id DESC LIMIT ?`).all(limit)) as Row[];
    return rows.map(toSignup);
  }

  // ---- login sessions ----

  createSession(token: string, expiresAtMs: number): void {
    this.#db.prepare('INSERT INTO sessions(token, expires_at) VALUES(?, ?)').run(token, expiresAtMs);
  }

  sessionValid(token: string, nowMs: number): boolean {
    this.#db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(nowMs); // tidy up
    return this.#db.prepare('SELECT 1 FROM sessions WHERE token = ? AND expires_at >= ?').get(token, nowMs) !== undefined;
  }

  deleteSession(token: string): void { this.#db.prepare('DELETE FROM sessions WHERE token = ?').run(token); }
  deleteAllSessions(): void { this.#db.exec('DELETE FROM sessions'); }
}
