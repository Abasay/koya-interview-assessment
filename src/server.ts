import { createApp } from './create-app.ts';
import { createDb } from './db.ts';
import * as dotenv from 'dotenv';
dotenv.config();

const apiKey = process.env.API_KEY || (process.env.NODE_ENV === 'production' ? '' : 'dev-key');
if (!apiKey) {
  console.error('API_KEY is not set');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.warn('DATABASE_URL not set: using an in-memory database. Bookings will not survive a restart.');
}

const db = await createDb(process.env.DATABASE_URL);

const app = createApp({ db, apiKey });

// On Vercel the platform calls the exported app itself; everywhere else we listen on a port.
if (!process.env.VERCEL) {
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => console.log(`Clinic booking API listening on :${port}`));
}

export default app;
