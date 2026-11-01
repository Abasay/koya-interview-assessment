import { test } from "node:test";
import assert from "node:assert/strict";
import { newBookingId, normalizeBookingId } from "../src/ids.ts";

const FORMAT = /^BK-[2-9A-HJKMNP-TV-Z]{4}-[2-9A-HJKMNP-TV-Z]{4}$/;

test("booking ids are short, readable and avoid lookalike characters", () => {
  for (let i = 0; i < 2000; i++) {
    const id = newBookingId();
    assert.match(id, FORMAT);
    assert.doesNotMatch(id.slice(3), /[01OILU]/);
  }
});

test("booking ids don't repeat in a large sample", () => {
  const ids = new Set(Array.from({ length: 20000 }, newBookingId));
  assert.equal(ids.size, 20000);
});

test("normalizeBookingId forgives case, spaces and missing dashes", () => {
  assert.equal(normalizeBookingId("BK-7K3M-9QX2"), "BK-7K3M-9QX2");
  assert.equal(normalizeBookingId("  bk-7k3m-9qx2 "), "BK-7K3M-9QX2");
  assert.equal(normalizeBookingId("bk7k3m9qx2"), "BK-7K3M-9QX2");
  assert.equal(normalizeBookingId("BK 7K3M 9QX2"), "BK-7K3M-9QX2");
});

test("normalizeBookingId leaves anything else alone so it simply isn't found", () => {
  assert.equal(normalizeBookingId("nope"), "nope");
  assert.equal(normalizeBookingId(" some-uuid "), "some-uuid");
});
