import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import type { Db } from './db.ts';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export function createApp({ db, apiKey }: { db: Db; apiKey: string }) {
  const app = express();
  app.disable('x-powered-by');
  app.get('/healthz', (req, res) => res.json({ ok: true }));
  app.use(express.static(PUBLIC_DIR));
  return app;
}
