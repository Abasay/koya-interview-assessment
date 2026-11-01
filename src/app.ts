import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { Db, Row } from './db.ts';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const fail = (res: Response, status: number, error: string) => res.status(status).json({ error });
const iso = (d: string | number | Date) => new Date(d).toISOString();

const present = (row: Row) => ({
  id: row.id,
  slot_id: row.slot_id,
  name: row.name,
  email: row.email,
  status: row.status,
  created_at: iso(row.created_at),
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Compare hashes so the check takes the same time wherever the keys differ.
function safeEqual(a: string, b: string) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function createApp({ db, apiKey }: { db: Db; apiKey: string }) {
  const api = express.Router();

  // Nothing below this line is reachable without the key.
  api.use((req: Request, res: Response, next: NextFunction) => {
    const key = req.get('x-api-key');
    if (!key || !safeEqual(key, apiKey)) return fail(res, 401, 'missing or invalid API key');
    next();
  });
  api.use(express.json({ limit: '100kb' }));

  // Replace all slots (also wipes bookings, so every test starts clean).
  api.post('/reset', async (req, res) => {
    const slots: unknown = req.body?.slots;
    if (!Array.isArray(slots)) return fail(res, 400, 'slots must be an array');
    const seen = new Set<string>();
    for (const s of slots as Record<string, any>[]) {
      const ok =
        s &&
        typeof s === 'object' &&
        ['id', 'provider', 'start', 'end'].every((k) => typeof s[k] === 'string' && s[k].trim()) &&
        !Number.isNaN(Date.parse(s.start)) &&
        !Number.isNaN(Date.parse(s.end));
      if (!ok) return fail(res, 400, 'each slot needs id, provider, start and end');
      if (seen.has(s.id)) return fail(res, 400, `duplicate slot id ${s.id}`);
      seen.add(s.id);
    }
    await db.tx(async (q) => {
      await q('truncate bookings, slots restart identity');
      for (const s of slots as Record<string, any>[]) {
        await q('insert into slots (id, provider, start, "end", start_at) values ($1,$2,$3,$4,$5)', [
          s.id,
          s.provider,
          s.start,
          s.end,
          new Date(s.start).toISOString(),
        ]);
      }
    });
    res.json({ ok: true, slots: slots.length });
  });

  // Every slot, earliest first. `available` is false while it has a confirmed booking.
  api.get('/slots', async (req, res) => {
    const { provider } = req.query;
    const params: string[] = [];
    let where = '';
    if (typeof provider === 'string') {
      params.push(provider);
      where = 'where s.provider = $1';
    }
    const { rows } = await db.query(
      `select s.id, s.provider, s.start, s."end",
              not exists (select 1 from bookings b where b.slot_id = s.id and b.status = 'confirmed') as available
         from slots s ${where}
        order by s.start_at, s.id`,
      params,
    );
    res.json({ slots: rows });
  });

  api.post('/bookings', async (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(res, 400, 'body must be a JSON object');

    // Spaces are trimmed and the email is stored in lower case, so "ADA@x.com " and "ada@x.com" are one person.
    const slotId = typeof body.slot_id === 'string' ? body.slot_id.trim() : '';
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!slotId) return fail(res, 400, 'slot_id is required');
    if (!name) return fail(res, 400, 'name is required');
    if (name.length > 200) return fail(res, 400, 'name is too long');
    if (!email) return fail(res, 400, 'email is required');
    if (email.length > 254 || !EMAIL_RE.test(email)) return fail(res, 400, 'email is not valid');

    const slot = (await db.query('select start_at from slots where id = $1', [slotId])).rows[0];
    if (!slot) return fail(res, 404, 'slot not found');
    if (new Date(slot.start_at).getTime() <= Date.now()) return fail(res, 400, 'slot has already started');

    // The unique index decides the winner when requests race: the loser's insert does nothing.
    const { rows } = await db.query(
      `insert into bookings (id, slot_id, name, email, status)
       values ($1, $2, $3, $4, 'confirmed')
       on conflict (slot_id) where status = 'confirmed' do nothing
       returning id, slot_id, name, email, status, created_at`,
      [crypto.randomUUID(), slotId, name, email],
    );
    if (!rows[0]) return fail(res, 409, 'slot is already booked');
    res.status(201).json(present(rows[0]));
  });

  api.get('/bookings/:id', async (req, res) => {
    const { rows } = await db.query('select id, slot_id, name, email, status, created_at from bookings where id = $1', [
      req.params.id,
    ]);
    if (!rows[0]) return fail(res, 404, 'booking not found');
    res.json(present(rows[0]));
  });

  // Cancelling keeps the record (status "cancelled") and frees the slot for someone else.
  api.delete('/bookings/:id', async (req, res) => {
    const out = await db.tx<{ status: number; body: unknown }>(async (q) => {
      const { rows } = await q(
        'select id, slot_id, name, email, status, created_at from bookings where id = $1 for update',
        [req.params.id],
      );
      if (!rows[0]) return { status: 404, body: { error: 'booking not found' } };
      if (rows[0].status === 'cancelled') return { status: 409, body: { error: 'booking is already cancelled' } };
      const updated = await q(
        "update bookings set status = 'cancelled' where id = $1 returning id, slot_id, name, email, status, created_at",
        [req.params.id],
      );
      return { status: 200, body: present(updated.rows[0]!) };
    });
    res.status(out.status).json(out.body);
  });

  api.use((req: Request, res: Response) => fail(res, 404, 'not found'));
  api.use((err: { type?: string }, req: Request, res: Response, next: NextFunction) => {
    if (err.type === 'entity.parse.failed') return fail(res, 400, 'invalid JSON');
    if (err.type === 'entity.too.large') return fail(res, 413, 'request body too large');
    console.error(err);
    fail(res, 500, 'internal error');
  });

  const app = express();
  app.disable('x-powered-by');
  app.get('/healthz', (req, res) => res.json({ ok: true }));

  // The web page talks to the API through /web, where the server adds the key.
  // That keeps the key out of the browser, and the page can't reset data.
  app.use(
    '/web',
    (req: Request, res: Response, next: NextFunction) => {
      if (req.path === '/reset') return fail(res, 404, 'not found');
      req.headers['x-api-key'] = apiKey;
      next();
    },
    api,
  );

  app.use(express.static(PUBLIC_DIR));
  app.use(api);
  return app;
}
