import assert from "node:assert/strict";
import test from "node:test";

import { occurrenceAfter, occurrenceAtOrBefore, parseRepeat } from "../src/recurrence.js";

const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());
const at = (s) => Date.parse(s);

test("non-repeating events have one occurrence at start_utc", () => {
  const start = "2026-09-29T03:00:00.000Z";
  assert.equal(parseRepeat('{"freq":"none"}'), null);
  assert.equal(iso(occurrenceAtOrBefore(start, "UTC", '{"freq":"none"}', at("2026-10-01T00:00:00Z"))), start);
  assert.equal(occurrenceAtOrBefore(start, "UTC", '{"freq":"none"}', at("2026-09-29T02:59:59Z")), null);
  assert.equal(iso(occurrenceAfter(start, "UTC", '{"freq":"none"}', at("2026-09-29T00:00:00Z"))), start);
  assert.equal(occurrenceAfter(start, "UTC", '{"freq":"none"}', at(start)), null);
});

test("daily keeps local wall time across a DST change", () => {
  // 09:00 America/New_York; DST ends 2026-11-01.
  const start = "2026-10-30T13:00:00.000Z";
  const rule = { freq: "daily" };
  assert.equal(iso(occurrenceAtOrBefore(start, "America/New_York", rule, at("2026-11-02T20:00:00Z"))), "2026-11-02T14:00:00.000Z");
  assert.equal(iso(occurrenceAfter(start, "America/New_York", rule, at("2026-10-31T13:00:00Z"))), "2026-11-01T14:00:00.000Z");
  assert.equal(occurrenceAtOrBefore(start, "America/New_York", rule, at("2026-10-30T12:59:59Z")), null);
});

test("weekly with interval, until, and count", () => {
  const start = "2026-09-07T01:00:00.000Z"; // Monday 09:00 Asia/Shanghai
  const tz = "Asia/Shanghai";
  const biweekly = { freq: "weekly", interval: 2 };
  assert.equal(iso(occurrenceAtOrBefore(start, tz, biweekly, at("2026-09-28T00:00:00Z"))), "2026-09-21T01:00:00.000Z");
  assert.equal(iso(occurrenceAfter(start, tz, biweekly, at("2026-09-21T01:00:00Z"))), "2026-10-05T01:00:00.000Z");
  const counted = { freq: "weekly", count: 3 };
  assert.equal(iso(occurrenceAtOrBefore(start, tz, counted, at("2027-01-01T00:00:00Z"))), "2026-09-21T01:00:00.000Z");
  assert.equal(occurrenceAfter(start, tz, counted, at("2026-09-21T01:00:00Z")), null);
  const until = { freq: "weekly", until: "2026-09-20T00:00:00Z" };
  assert.equal(iso(occurrenceAtOrBefore(start, tz, until, at("2027-01-01T00:00:00Z"))), "2026-09-14T01:00:00.000Z");
  assert.equal(occurrenceAfter(start, tz, until, at("2026-09-14T01:00:00Z")), null);
});

test("monthly skips months without the day and counts real occurrences", () => {
  const start = "2026-01-31T02:00:00.000Z"; // 10:00 Asia/Shanghai on the 31st
  const tz = "Asia/Shanghai";
  const rule = { freq: "monthly" };
  assert.equal(iso(occurrenceAtOrBefore(start, tz, rule, at("2026-03-15T00:00:00Z"))), "2026-01-31T02:00:00.000Z");
  assert.equal(iso(occurrenceAfter(start, tz, rule, at("2026-01-31T02:00:00Z"))), "2026-03-31T02:00:00.000Z");
  assert.equal(iso(occurrenceAfter(start, tz, rule, at("2026-03-31T02:00:00Z"))), "2026-05-31T02:00:00.000Z");
  const three = { freq: "monthly", count: 3 };
  assert.equal(iso(occurrenceAtOrBefore(start, tz, three, at("2027-01-01T00:00:00Z"))), "2026-05-31T02:00:00.000Z");
  assert.equal(occurrenceAfter(start, tz, three, at("2026-05-31T02:00:00Z")), null);
});

test("an unknown timezone falls back to UTC", () => {
  const start = "2026-09-29T03:00:00.000Z";
  assert.equal(iso(occurrenceAfter(start, "Nowhere/Else", { freq: "daily" }, at(start))), "2026-09-30T03:00:00.000Z");
});
