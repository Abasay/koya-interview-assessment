import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.ts";
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
  for (const over of bad) {
    const r = await book(over);
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
