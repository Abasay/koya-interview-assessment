import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/create-app.ts";
import { createDb, type Db } from "../src/db.ts";

const KEY = "test-key";
let server: Server, base: string, db: Db;

const future = (days: number, hour = 9) => new Date(Date.UTC(2099, 0, days, hour)).toISOString().replace(".000Z", "Z");
const SLOTS = [
  { id: "s2", provider: "Dr Bola", start: future(2), end: future(2, 10) },
  { id: "s1", provider: "Dr Ade", start: future(1), end: future(1, 10) },
  { id: "s3", provider: "Dr Ade", start: future(3), end: future(3, 10) },
];

interface Opts { body?: unknown; headers?: Record<string, string>; key?: string | null }

async function call(method: string, path: string, { body, headers = {}, key = KEY }: Opts = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(key ? { "X-API-Key": key } : {}), ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: (text ? JSON.parse(text) : null) as any };
}
const book = (over: Record<string, unknown> = {}, opts?: Opts) =>
  call("POST", "/bookings", { body: { slot_id: "s1", name: "Ada Obi", email: "ada@example.com", ...over }, ...opts });

before(async () => {
  db = await createDb();
  server = createApp({ db, apiKey: KEY }).listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  server.close();
  await db.close();
});
beforeEach(async () => {
  const r = await call("POST", "/reset", { body: { slots: SLOTS } });
  assert.equal(r.status, 200);
});

test("level 1: slots sorted by start, filter by provider, availability", async () => {
  const all = await call("GET", "/slots");
  assert.deepEqual(all.json.slots.map((s: { id: string }) => s.id), ["s1", "s2", "s3"]);
  assert.equal(all.json.slots[0].available, true);
  const ade = await call("GET", "/slots?provider=Dr%20Ade");
  assert.deepEqual(ade.json.slots.map((s: { id: string }) => s.id), ["s1", "s3"]);
  assert.deepEqual((await call("GET", "/slots?provider=nobody")).json, { slots: [] });
});

test("level 1: reset replaces slots and wipes bookings", async () => {
  await book();
  await call("POST", "/reset", { body: { slots: [SLOTS[0]] } });
  assert.deepEqual((await call("GET", "/slots")).json.slots.map((s: { id: string }) => s.id), ["s2"]);
  const { rows } = await db.query("select count(*)::int as n from bookings");
  assert.equal(rows[0]!.n, 0);
  assert.equal((await call("POST", "/reset", { body: { slots: "nope" } })).status, 400);
});

test("level 1: book and look up", async () => {
  const b = await book();
  assert.equal(b.status, 201);
  assert.equal(b.json.status, "confirmed");
  assert.equal(b.json.slot_id, "s1");
  assert.equal(b.json.name, "Ada Obi");
  assert.ok(b.json.id && b.json.created_at);
  const found = await call("GET", `/bookings/${b.json.id}`);
  assert.equal(found.status, 200);
  assert.deepEqual(found.json, b.json);
  assert.equal((await call("GET", "/bookings/nope")).status, 404);
  const slots = (await call("GET", "/slots")).json.slots;
  assert.equal(slots.find((s: { id: string }) => s.id === "s1").available, false);
});

test("level 1: booking a slot that doesn't exist is 404", async () => {
  assert.equal((await book({ slot_id: "missing" })).status, 404);
});

test("level 2: every endpoint needs the key", async () => {
  for (const key of [null, "wrong", ""]) {
    for (const [method, path] of [["GET", "/slots"], ["POST", "/bookings"], ["GET", "/bookings/x"], ["POST", "/reset"]] as const) {
      const r = await call(method, path, { key, body: method === "POST" ? {} : undefined });
      assert.equal(r.status, 401, `${method} ${path} with key ${JSON.stringify(key)}`);
      assert.ok(r.json.error);
    }
  }
});

test("level 2: missing, empty or invalid details are 400", async () => {
  const bad: Record<string, unknown>[] = [
    { slot_id: "" }, { slot_id: undefined }, { slot_id: 5 },
    { name: "" }, { name: "   " }, { name: undefined }, { name: 5 },
    { email: "" }, { email: undefined }, { email: 5 },
    { email: "not-an-email" }, { email: "a@b" }, { email: "a b@c.com" },
  ];
  let n = 0;
  for (const over of bad) {
    const r = await book({ email: `v${n++}@example.com`, ...over });
    assert.equal(r.status, 400, JSON.stringify(over));
    assert.ok(r.json.error);
  }
  assert.equal((await call("POST", "/bookings", { body: "{not json" })).status, 400);
  assert.equal((await call("POST", "/bookings", { body: [1, 2] })).status, 400);
  const { rows } = await db.query("select count(*)::int as n from bookings");
  assert.equal(rows[0]!.n, 0);
});

test("level 2: unknown slot is 404, a slot that has started is 400", async () => {
  await call("POST", "/reset", { body: { slots: [...SLOTS, { id: "past", provider: "Dr Ade", start: "2020-01-01T09:00:00Z", end: "2020-01-01T09:30:00Z" }] } });
  assert.equal((await book({ slot_id: "missing" })).status, 404);
  const started = await book({ slot_id: "past" });
  assert.equal(started.status, 400);
  assert.match(started.json.error, /started/);
});

test("level 2: name and email are trimmed and the email is lower-cased", async () => {
  const r = await book({ name: "  Ada Obi  ", email: "  ADA@Example.COM " });
  assert.equal(r.status, 201);
  assert.equal(r.json.name, "Ada Obi");
  assert.equal(r.json.email, "ada@example.com");
});

test("level 2: the web page reaches the API without a key, but cannot reset", async () => {
  assert.equal((await call("GET", "/web/slots", { key: null })).status, 200);
  assert.equal((await call("POST", "/web/reset", { key: null, body: { slots: [] } })).status, 404);
  const page = await fetch(base + "/");
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<html/i);
});

test("level 3: a second booking for the same slot is 409", async () => {
  assert.equal((await book()).status, 201);
  const second = await book({ email: "other@example.com" });
  assert.equal(second.status, 409);
  assert.ok(second.json.error);
  const { rows } = await db.query("select count(*)::int as n from bookings where slot_id = 's1'");
  assert.equal(rows[0]!.n, 1);
});

test("level 3: different slots don't block each other", async () => {
  assert.equal((await book({ slot_id: "s1" })).status, 201);
  assert.equal((await book({ slot_id: "s2" })).status, 201);
});

test("level 3: simultaneous requests produce exactly one booking", async () => {
  const results = await Promise.all(Array.from({ length: 30 }, (_, i) => book({ email: `p${i}@example.com` })));
  const codes = results.map((r) => r.status);
  assert.equal(codes.filter((c) => c === 201).length, 1);
  assert.equal(codes.filter((c) => c === 409).length, 29);
  const { rows } = await db.query("select count(*)::int as n from bookings where slot_id = 's1' and status = 'confirmed'");
  assert.equal(rows[0]!.n, 1);
});

test("level 3: cancelling returns the booking, frees the slot and can't be repeated", async () => {
  const a = await book();
  const del = await call("DELETE", `/bookings/${a.json.id}`);
  assert.equal(del.status, 200);
  assert.equal(del.json.status, "cancelled");
  assert.equal(del.json.id, a.json.id);
  assert.equal((await call("GET", `/bookings/${a.json.id}`)).json.status, "cancelled");
  assert.equal((await call("DELETE", `/bookings/${a.json.id}`)).status, 409);
  assert.equal((await call("DELETE", "/bookings/nope")).status, 404);
  assert.equal((await call("GET", "/slots")).json.slots.find((s: { id: string }) => s.id === "s1").available, true);
  const rebook = await book({ email: "other@example.com" });
  assert.equal(rebook.status, 201);
  assert.notEqual(rebook.json.id, a.json.id);
});

test("level 3: cancelling needs the key", async () => {
  const a = await book();
  assert.equal((await call("DELETE", `/bookings/${a.json.id}`, { key: null })).status, 401);
});

test("level 4: same key and body replays the same booking, never a second one", async () => {
  const h = { "Idempotency-Key": "k1" };
  const first = await book({}, { headers: h });
  const again = await book({}, { headers: h });
  assert.equal(first.status, 201);
  assert.equal(again.status, 201);
  assert.equal(again.json.id, first.json.id);
  assert.deepEqual(again.json, first.json);
  const { rows } = await db.query("select count(*)::int as n from bookings");
  assert.equal(rows[0]!.n, 1);
});

test("level 4: same key with a different body is 422 and books nothing", async () => {
  const h = { "Idempotency-Key": "k2" };
  assert.equal((await book({}, { headers: h })).status, 201);
  assert.equal((await book({ name: "Someone Else" }, { headers: h })).status, 422);
  assert.equal((await book({ slot_id: "s2" }, { headers: h })).status, 422);
  const { rows } = await db.query("select count(*)::int as n from bookings");
  assert.equal(rows[0]!.n, 1);
});

test("level 4: different keys are independent, and no key means no deduplication", async () => {
  assert.equal((await book({ slot_id: "s1" }, { headers: { "Idempotency-Key": "a" } })).status, 201);
  assert.equal((await book({ slot_id: "s2" }, { headers: { "Idempotency-Key": "b" } })).status, 201);
  assert.equal((await book({ slot_id: "s3" })).status, 201);
  assert.equal((await book({ slot_id: "s3" })).status, 409);
});

test("level 4: a retry still gets the original answer after the booking was cancelled", async () => {
  const h = { "Idempotency-Key": "k3" };
  const first = await book({}, { headers: h });
  await call("DELETE", `/bookings/${first.json.id}`);
  const retry = await book({}, { headers: h });
  assert.equal(retry.status, 201);
  assert.equal(retry.json.id, first.json.id);
});

test("level 4: concurrent retries with one key create one booking", async () => {
  const h = { "Idempotency-Key": "race" };
  const rs = await Promise.all(Array.from({ length: 5 }, () => book({}, { headers: h })));
  assert.ok(rs.every((r) => r.status === 201 && r.json.id === rs[0]!.json.id));
  const { rows } = await db.query("select count(*)::int as n from bookings");
  assert.equal(rows[0]!.n, 1);
});

test("level 4: a failed attempt is not remembered, so the retry can succeed", async () => {
  const h = { "Idempotency-Key": "k4" };
  assert.equal((await book({ slot_id: "missing" }, { headers: h })).status, 404);
  const fixed = await book({}, { headers: h }); // same key, corrected body
  assert.equal(fixed.status, 201);
  assert.equal((await book({}, { headers: h })).json.id, fixed.json.id);
});

async function makeFive() {
  await call("POST", "/reset", {
    body: { slots: Array.from({ length: 5 }, (_, i) => ({ id: `x${i}`, provider: "P", start: future(10 + i), end: future(10 + i, 10) })) },
  });
  const ids: string[] = [];
  for (let i = 0; i < 5; i++) {
    const r = await book({ slot_id: `x${i}`, email: i % 2 ? "ADA@example.com" : "ada@example.com" });
    ids.push(r.json.id);
  }
  await book({ slot_id: "x0", email: "bob@example.com" }); // 409, and bob has none anyway
  return ids;
}

test("level 4: bookings page oldest first, case-insensitive email, last page has a null cursor", async () => {
  const ids = await makeFive();
  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const r: Awaited<ReturnType<typeof call>> = await call("GET", `/bookings?email=Ada@Example.com&limit=2${cursor ? `&cursor=${cursor}` : ""}`);
    assert.equal(r.status, 200);
    assert.ok(r.json.bookings.length <= 2);
    seen.push(...r.json.bookings.map((b: { id: string }) => b.id));
    cursor = r.json.next_cursor;
    pages++;
  } while (cursor);
  assert.deepEqual(seen, ids);
  assert.equal(pages, 3);
});

test("level 4: default limit is 10, an exact fit has no next page, other people are excluded", async () => {
  await makeFive();
  const all = await call("GET", "/bookings?email=ada@example.com");
  assert.equal(all.json.bookings.length, 5);
  assert.equal(all.json.next_cursor, null);
  const exact = await call("GET", "/bookings?email=ada@example.com&limit=5");
  assert.equal(exact.json.next_cursor, null);
  assert.deepEqual((await call("GET", "/bookings?email=nobody@example.com")).json, { bookings: [], next_cursor: null });
  assert.equal((await call("GET", "/bookings?email=bob@example.com")).json.bookings.length, 0);
});

test("level 4: cancelled bookings still appear in the list", async () => {
  const ids = await makeFive();
  await call("DELETE", `/bookings/${ids[0]}`);
  const r = await call("GET", "/bookings?email=ada@example.com");
  assert.equal(r.json.bookings[0].status, "cancelled");
});

test("level 4: bad limit, cursor or email is 400", async () => {
  for (const q of ["limit=0", "limit=51", "limit=abc", "limit=1.5", "limit=-1", "limit=", "cursor=%25%25%25", "cursor=abc"]) {
    assert.equal((await call("GET", `/bookings?email=ada@example.com&${q}`)).status, 400, q);
  }
  assert.equal((await call("GET", "/bookings")).status, 400);
  assert.equal((await call("GET", "/bookings?email=ada@example.com", { key: null })).status, 401);
});

test("level 5: the 6th attempt for an email in a minute is 429 with Retry-After", async () => {
  for (let i = 0; i < 5; i++) {
    const r = await book({ slot_id: "missing", email: "spam@example.com" });
    assert.equal(r.status, 404, `attempt ${i + 1} should still be answered normally`);
  }
  const blocked = await book({ slot_id: "missing", email: "spam@example.com" });
  assert.equal(blocked.status, 429);
  assert.ok(blocked.json.error);
  const retryAfter = blocked.headers.get("retry-after")!;
  assert.match(retryAfter, /^\d+$/);
  assert.ok(Number(retryAfter) >= 1 && Number(retryAfter) <= 60);
});

test("level 5: failed attempts count, and a good request is blocked once the limit is hit", async () => {
  for (let i = 0; i < 5; i++) assert.equal((await book({ name: "", email: "spam@example.com" })).status, 400);
  assert.equal((await book({ email: "spam@example.com" })).status, 429);
  const { rows } = await db.query("select count(*)::int as n from bookings");
  assert.equal(rows[0]!.n, 0);
});

test("level 5: other emails are not affected, and case and spaces don't dodge the limit", async () => {
  for (let i = 0; i < 5; i++) await book({ slot_id: "missing", email: "spam@example.com" });
  assert.equal((await book({ slot_id: "missing", email: "  SPAM@Example.com " })).status, 429);
  assert.equal((await book({ email: "fine@example.com" })).status, 201);
});

test("level 5: exactly 5 simultaneous attempts pass, the rest get 429", async () => {
  const rs = await Promise.all(Array.from({ length: 12 }, () => book({ slot_id: "missing", email: "burst@example.com" })));
  assert.equal(rs.filter((r) => r.status === 404).length, 5);
  assert.equal(rs.filter((r) => r.status === 429).length, 7);
});

test("level 5: attempts older than a minute stop counting", async () => {
  for (let i = 0; i < 5; i++) await book({ slot_id: "missing", email: "old@example.com" });
  assert.equal((await book({ slot_id: "missing", email: "old@example.com" })).status, 429);
  await db.query("update attempts set at = now() - interval '61 seconds' where email = 'old@example.com'");
  assert.equal((await book({ slot_id: "missing", email: "old@example.com" })).status, 404);
});

test("level 5: reads and cancels are not rate limited", async () => {
  const a = await book({ email: "reader@example.com" });
  for (let i = 0; i < 8; i++) assert.equal((await call("GET", "/bookings?email=reader@example.com")).status, 200);
  assert.equal((await call("GET", `/bookings/${a.json.id}`)).status, 200);
  assert.equal((await call("DELETE", `/bookings/${a.json.id}`)).status, 200);
});

test("booking ids are friendly, and lookups and cancels forgive case, spaces and dashes", async () => {
  const b = await book();
  assert.match(b.json.id, /^BK-[2-9A-HJKMNP-TV-Z]{4}-[2-9A-HJKMNP-TV-Z]{4}$/);
  const messy = ` ${b.json.id.toLowerCase().replaceAll("-", "")} `;
  const found = await call("GET", `/bookings/${encodeURIComponent(messy)}`);
  assert.equal(found.status, 200);
  assert.equal(found.json.id, b.json.id);
  const del = await call("DELETE", `/bookings/${b.json.id.toLowerCase()}`);
  assert.equal(del.json.status, "cancelled");
  assert.equal(del.json.id, b.json.id);
});

test("booking ids are unique across bookings, and the id in the list matches the one returned", async () => {
  const a = await book({ slot_id: "s1", email: "ids@example.com" });
  const b = await book({ slot_id: "s2", email: "ids@example.com" });
  assert.notEqual(a.json.id, b.json.id);
  const list = await call("GET", "/bookings?email=ids@example.com");
  assert.deepEqual(list.json.bookings.map((x: { id: string }) => x.id), [a.json.id, b.json.id]);
});

async function manySlots() {
  // 3 days x 2 providers x 3 times = 18 slots, ids n01..n18
  const slots = [];
  let n = 1;
  for (let d = 1; d <= 3; d++) {
    for (const provider of ["Dr Ade", "Dr Bola"]) {
      for (const hour of [9, 10, 11]) {
        slots.push({ id: `n${String(n++).padStart(2, "0")}`, provider, start: future(d, hour), end: future(d, hour + 1) });
      }
    }
  }
  assert.equal((await call("POST", "/reset", { body: { slots } })).status, 200);
  return slots;
}
const ids = (r: { json: any }) => r.json.slots.map((s: { id: string }) => s.id);

test("slots: with no options every slot comes back in one response, with no cursor", async () => {
  await manySlots();
  const all = await call("GET", "/slots");
  assert.equal(all.json.slots.length, 18);
  assert.equal("next_cursor" in all.json, false);
  assert.equal("start_at" in all.json.slots[0], false);
});

test("slots: date filter returns only that UTC day", async () => {
  await manySlots();
  const day2 = await call("GET", `/slots?date=${future(2).slice(0, 10)}`);
  assert.equal(day2.json.slots.length, 6);
  assert.ok(day2.json.slots.every((s: { start: string }) => s.start.startsWith(future(2).slice(0, 10))));
  assert.deepEqual((await call("GET", "/slots?date=2030-01-01")).json, { slots: [] });
});

test("slots: from and to are inclusive, and combine with provider", async () => {
  await manySlots();
  const range = await call("GET", `/slots?from=${future(2).slice(0, 10)}&to=${future(3).slice(0, 10)}`);
  assert.equal(range.json.slots.length, 12);
  const open = await call("GET", `/slots?from=${future(3).slice(0, 10)}`);
  assert.equal(open.json.slots.length, 6);
  const mix = await call("GET", `/slots?date=${future(1).slice(0, 10)}&provider=Dr%20Bola`);
  assert.deepEqual(ids(mix), ["n04", "n05", "n06"]);
});

test("slots: pages walk the whole list in order with no gaps or repeats", async () => {
  await manySlots();
  const full = ids(await call("GET", "/slots"));
  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const r: Awaited<ReturnType<typeof call>> = await call("GET", `/slots?limit=5${cursor ? `&cursor=${cursor}` : ""}`);
    assert.equal(r.status, 200);
    assert.ok(r.json.slots.length <= 5);
    seen.push(...ids(r));
    cursor = r.json.next_cursor;
    pages++;
  } while (cursor);
  assert.deepEqual(seen, full);
  assert.equal(pages, 4);
});

test("slots: paging works together with filters, and an exact fit ends with a null cursor", async () => {
  await manySlots();
  const p1 = await call("GET", "/slots?provider=Dr%20Ade&limit=4");
  assert.equal(p1.json.slots.length, 4);
  assert.ok(p1.json.next_cursor);
  const p2 = await call("GET", `/slots?provider=Dr%20Ade&limit=4&cursor=${p1.json.next_cursor}`);
  assert.equal(p2.json.slots.length, 4);
  assert.ok(p2.json.slots.every((s: { provider: string }) => s.provider === "Dr Ade"));
  const p3 = await call("GET", `/slots?provider=Dr%20Ade&limit=4&cursor=${p2.json.next_cursor}`);
  assert.equal(p3.json.slots.length, 1);
  assert.equal(p3.json.next_cursor, null);
  assert.equal((await call("GET", "/slots?provider=Dr%20Ade&limit=9")).json.next_cursor, null);
});

test("slots: booking a slot between pages doesn't shift the next page", async () => {
  await manySlots();
  const p1 = await call("GET", "/slots?limit=3");
  const before = await call("GET", `/slots?limit=3&cursor=${p1.json.next_cursor}`);
  const taken = p1.json.slots[0].id;
  assert.equal((await call("POST", "/bookings", { body: { slot_id: taken, name: "Ada", email: "a@example.com" } })).status, 201);
  const after = await call("GET", `/slots?limit=3&cursor=${p1.json.next_cursor}`);
  assert.deepEqual(ids(after), ids(before));
  assert.equal(after.json.slots.length, 3);
});

test("slots: bad limit, cursor or dates are 400, and the key is still required", async () => {
  for (const q of ["limit=0", "limit=101", "limit=abc", "limit=1.5", "limit=", "cursor=abc", "cursor=", "date=2026-13-40", "date=tomorrow", "from=2026-1-1", "date=2030-01-01&from=2030-01-01"]) {
    assert.equal((await call("GET", `/slots?${q}`)).status, 400, q);
  }
  assert.equal((await call("GET", "/slots?limit=5", { key: null })).status, 401);
});

test("providers: lists each provider once, sorted", async () => {
  await manySlots();
  assert.deepEqual((await call("GET", "/providers")).json, { providers: ["Dr Ade", "Dr Bola"] });
  assert.equal((await call("GET", "/providers", { key: null })).status, 401);
});
