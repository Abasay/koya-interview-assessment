# Clinic booking API

A booking API for a clinic, plus a small web page that uses it. TypeScript, Express and Postgres.
It implements the Koya Task 1 contract (levels 1-5): https://koyaacademy.com/assessment-api

## Run locally

    npm install
    npm run build      # compiles src/ to dist/ and the page script to public/app.js
    npm start          # http://localhost:3000, API key "dev-key", in-memory database
    npm test           # runs the .ts tests directly (Node 22.18+)
    npm run typecheck

With no `DATABASE_URL` it runs an in-process Postgres (PGlite), so nothing needs installing.
Set `DATABASE_URL` to use a real Postgres, and `API_KEY` for anything but local use.

Careful: a `.env` file with a real `DATABASE_URL` makes local runs touch that database. To stay safe,
start with `DATABASE_URL= API_KEY=dev-key npm start`.

## Deploy (Vercel + Neon)

1. Neon: create a project and copy the pooled connection string.
2. Vercel: import the repo. Set `API_KEY` (any secret you choose) and `DATABASE_URL` for every environment.
3. Deploy. The page is served from `public/`, and `src/server.ts` is the function entry point.
4. Optional demo data: `BASE_URL=https://your-app.vercel.app API_KEY=… npm run seed` (see `scripts/seed.ts`).
   It calls `POST /reset`, so it replaces all slots and deletes all bookings.

## Endpoints

Every request needs the `X-API-Key` header. Errors are `{"error": "..."}`.

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/reset` | Replace all slots, delete all bookings |
| GET | `/slots` | All slots, earliest first. Optional: `provider`, `date` or `from`/`to` (UTC days), `limit` (1-100) and `cursor` |
| GET | `/providers` | Provider names, for the page's filter |
| POST | `/bookings` | Book a slot. Optional `Idempotency-Key` header |
| GET | `/bookings?email=` | A person's bookings, oldest first, `limit` and `cursor` |
| GET | `/bookings/{id}` | Look up a booking. The id forgives case, spaces and missing dashes |
| DELETE | `/bookings/{id}` | Cancel a booking and free its slot |

`GET /slots` with no options returns every slot in one response, as the contract says. Paging only starts
when `limit` or `cursor` is sent, which is what the web page does.

## How the guarantees are met

- **Double booking (L3):** a partial unique index, `bookings(slot_id) where status = 'confirmed'`. The insert
  uses `on conflict do nothing`, so of any number of simultaneous requests the database lets exactly one
  through; the rest get 409. Cancelling flips the status, which frees the slot.
- **Idempotency (L4):** the key, a hash of the request body and the stored response live in a table. A
  per-key lock makes concurrent retries wait for the first. Same key with a different body is 422. Only
  successful bookings are stored, so a retry after a 400/404/409 is simply re-evaluated.
- **Paging (L4):** keyset cursors, on insertion order for bookings and on (start, id) for slots, so pages
  stay stable while data changes.
- **Rate limit (L5):** every attempt that carries an email is recorded in Postgres, so the limit holds across
  restarts and instances. A sliding 60 second window allows 5. Rejected attempts are not recorded, so
  `Retry-After` is the real wait.
- **Booking ids:** `BK-7K3M-9QX2`. No 0/O, 1/I/L/U, so they survive being read out or retyped.
- **Web page:** calls the API through `/web/*`, where the server adds the key, so the key never reaches the
  browser. `/web/reset` is blocked. Booking limits still apply there.

## Known limits

- The tests run on PGlite, which handles one connection at a time, so the concurrency test doesn't use true
  parallelism. The guarantee comes from the unique index, which behaves the same on real Postgres.
- Idempotent replays count as attempts for the rate limit.
