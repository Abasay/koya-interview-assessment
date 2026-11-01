import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Request, type Response } from 'express';
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

export function createApp({ db }: { db: Db; apiKey: string }) {
  const api = express.Router();
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
    const { slot_id, name, email } = req.body ?? {};
    const slot = (await db.query('select id from slots where id = $1', [slot_id])).rows[0];
    if (!slot) return fail(res, 404, 'slot not found');
    const { rows } = await db.query(
      `insert into bookings (id, slot_id, name, email, status)
       values ($1, $2, $3, $4, 'confirmed')
       returning id, slot_id, name, email, status, created_at`,
      [crypto.randomUUID(), slot_id, name, email],
    );
    res.status(201).json(present(rows[0]!));
  });

  api.get('/bookings/:id', async (req, res) => {
    const { rows } = await db.query('select id, slot_id, name, email, status, created_at from bookings where id = $1', [
      req.params.id,
    ]);
    if (!rows[0]) return fail(res, 404, 'booking not found');
    res.json(present(rows[0]));
  });

  api.use((req: Request, res: Response) => fail(res, 404, 'not found'));

  const app = express();
  app.disable('x-powered-by');
  app.get('/healthz', (req, res) => res.json({ ok: true }));
  app.use(express.static(PUBLIC_DIR));
  app.use(api);
  return app;
}
