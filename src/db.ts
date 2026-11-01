// Database adapter. Postgres (Neon, Render, ...) when DATABASE_URL is set,
// otherwise an in-process Postgres (PGlite) so local dev and tests need nothing installed.
// Both speak the same SQL, so the concurrency guarantees below are tested on the real thing.

const SCHEMA = `
create table if not exists slots (
  id       text primary key,
  provider text not null,
  start    text not null,
  "end"    text not null,
  start_at timestamptz not null
);
create table if not exists bookings (
  seq        bigserial primary key,
  id         text not null unique,
  slot_id    text not null,
  name       text not null,
  email      text not null,
  status     text not null,
  created_at timestamptz not null default now()
);
-- The double-booking guarantee: the database itself refuses a second confirmed booking for a slot,
-- however many requests arrive at once. Cancelling flips status, which frees the slot again.
create unique index if not exists one_confirmed_per_slot on bookings (slot_id) where status = 'confirmed';
create index if not exists bookings_by_email on bookings (email, seq);
-- Remembers the response to each Idempotency-Key so a retry gets the same answer, not a second booking.
create table if not exists idempotency (
  key          text primary key,
  request_hash text not null,
  status       int  not null,
  body         text not null
);
-- One row per booking attempt, used to count attempts per email over the last minute.
create table if not exists attempts (
  id    bigserial primary key,
  email text not null,
  at    timestamptz not null default now()
);
create index if not exists attempts_by_email on attempts (email, at);
`;

export type Row = Record<string, any>;
export type Query = (text: string, params?: unknown[]) => Promise<{ rows: Row[] }>;
export interface Db {
  query: Query;
  tx<T>(fn: (q: Query) => Promise<T>): Promise<T>;
  exec(text: string): Promise<unknown>;
  close(): Promise<unknown>;
}

export async function createDb(url?: string): Promise<Db> {
  let db: Db;
  if (url) {
    const { default: pg } = await import("pg");
    const pool = new pg.Pool({ connectionString: url, max: Number(process.env.PG_POOL_MAX) || 5 });
    db = {
      query: (text, params) => pool.query(text, params as unknown[]),
      async tx<T>(fn: (q: Query) => Promise<T>) {
        const client = await pool.connect();
        try {
          await client.query("begin");
          const out = await fn((text, params) => client.query(text, params as unknown[]));
          await client.query("commit");
          return out;
        } catch (err) {
          await client.query("rollback").catch(() => {});
          throw err;
        } finally {
          client.release();
        }
      },
      exec: (text) => pool.query(text),
      close: () => pool.end(),
    };
  } else {
    const { PGlite } = await import("@electric-sql/pglite");
    const lite = new PGlite();
    db = {
      query: (text, params) => lite.query<Row>(text, params),
      tx: (fn) => lite.transaction((t) => fn((text, params) => t.query<Row>(text, params))),
      exec: (text) => lite.exec(text),
      close: () => lite.close(),
    };
  }
  await db.exec(SCHEMA);
  return db;
}
