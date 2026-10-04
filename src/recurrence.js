/**
 * Calendar recurrence: repeat = {freq: none|daily|weekly|monthly, interval?, until?, count?}.
 *
 * Occurrence n keeps the first start's wall-clock time in the event's timezone,
 * so a 09:00 Asia/Shanghai daily stays 09:00 local across DST elsewhere.
 * Monthly keeps the day of month; a month without that day (the 31st in
 * April) has no occurrence, as in RFC 5545. `count` counts real occurrences
 * and `until` is an inclusive UTC instant.
 */

const DAY_MS = 86_400_000;
const PERIOD_MS = { daily: DAY_MS, weekly: 7 * DAY_MS, monthly: 30.436875 * DAY_MS };
const MAX_STEPS = 2000;
export const MAX_INTERVAL = 366;
export const MAX_COUNT = 1000;

const formatters = new Map();

function formatter(timeZone) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export function validTimeZone(timeZone) {
  if (typeof timeZone !== "string" || timeZone === "") return false;
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

function localParts(timeZone, utcMs) {
  const out = {};
  for (const p of formatter(timeZone).formatToParts(new Date(utcMs))) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return { y: out.year, m: out.month, d: out.day, h: out.hour, mi: out.minute, s: out.second };
}

function offsetMs(timeZone, utcMs) {
  const p = localParts(timeZone, utcMs);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** Wall-clock time in timeZone to a UTC instant. A skipped DST hour resolves forward. */
function localToUtc(timeZone, y, m0, d, h, mi, s, ms) {
  const guess = Date.UTC(y, m0, d, h, mi, s, ms);
  const first = offsetMs(timeZone, guess);
  let t = guess - first;
  const second = offsetMs(timeZone, t);
  if (second !== first) t = guess - second;
  return t;
}

function daysInMonth(y, m0) {
  return new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();
}

/** Parsed rule, or null when the event does not repeat. */
export function parseRepeat(value) {
  let r = value;
  if (typeof value === "string") {
    try {
      r = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!r || typeof r !== "object" || !PERIOD_MS[r.freq]) return null;
  const interval = Number.isInteger(r.interval) && r.interval >= 1 ? r.interval : 1;
  const untilMs = typeof r.until === "string" ? Date.parse(r.until) : NaN;
  const count = Number.isInteger(r.count) && r.count >= 1 ? r.count : null;
  return { freq: r.freq, interval, untilMs: Number.isFinite(untilMs) ? untilMs : null, count };
}

/** Throws a message string for a bad interval, until, or count. */
export function assertRepeatFields(r) {
  if (r.interval !== undefined && !(Number.isInteger(r.interval) && r.interval >= 1 && r.interval <= MAX_INTERVAL)) {
    throw `repeat.interval must be an integer from 1 to ${MAX_INTERVAL}`;
  }
  if (r.count !== undefined && !(Number.isInteger(r.count) && r.count >= 1 && r.count <= MAX_COUNT)) {
    throw `repeat.count must be an integer from 1 to ${MAX_COUNT}`;
  }
  if (r.until !== undefined && (typeof r.until !== "string" || !Number.isFinite(Date.parse(r.until)))) {
    throw "repeat.until must be an ISO8601 time";
  }
}

function series(startUtc, timeZone, rule) {
  const startMs = Date.parse(startUtc);
  if (!Number.isFinite(startMs)) return null;
  const tz = validTimeZone(timeZone) ? timeZone : "UTC";
  const p = localParts(tz, startMs);
  const ms = startMs % 1000;
  const at = (n) => {
    if (rule.freq === "monthly") {
      const months = p.m - 1 + n * rule.interval;
      const y = p.y + Math.floor(months / 12);
      const m0 = ((months % 12) + 12) % 12;
      if (p.d > daysInMonth(y, m0)) return null;
      return localToUtc(tz, y, m0, p.d, p.h, p.mi, p.s, ms);
    }
    const step = rule.freq === "weekly" ? 7 * rule.interval : rule.interval;
    return localToUtc(tz, p.y, p.m - 1, p.d + n * step, p.h, p.mi, p.s, ms);
  };
  return { startMs, at, period: PERIOD_MS[rule.freq] * rule.interval };
}

/** Index of the count-th real occurrence, or null when count is unset. */
function lastIndex(s, rule) {
  if (rule.count == null) return null;
  if (rule.freq !== "monthly") return rule.count - 1;
  let seen = 0;
  for (let n = 0; n < MAX_STEPS * 12; n++) {
    if (s.at(n) != null && ++seen === rule.count) return n;
  }
  return null;
}

function inRule(s, rule, n, t) {
  if (t == null) return false;
  if (rule.untilMs != null && t > rule.untilMs) return false;
  const last = lastIndex(s, rule);
  return last == null || n <= last;
}

/** Latest occurrence start (UTC ms) at or before atMs, or null. */
export function occurrenceAtOrBefore(startUtc, timeZone, repeat, atMs) {
  const rule = parseRepeat(repeat);
  const startMs = Date.parse(startUtc);
  if (!rule) return Number.isFinite(startMs) && startMs <= atMs ? startMs : null;
  const s = series(startUtc, timeZone, rule);
  if (!s || s.startMs > atMs) return null;
  const limit = rule.untilMs != null ? Math.min(atMs, rule.untilMs) : atMs;
  let n = Math.max(0, Math.floor((limit - s.startMs) / s.period) + 2);
  const last = lastIndex(s, rule);
  if (last != null) n = Math.min(n, last);
  for (let i = 0; n >= 0 && i < MAX_STEPS; n--, i++) {
    const t = s.at(n);
    if (t != null && t <= limit) return inRule(s, rule, n, t) ? t : null;
  }
  return null;
}

/** First occurrence start (UTC ms) strictly after afterMs, or null. */
export function occurrenceAfter(startUtc, timeZone, repeat, afterMs) {
  const rule = parseRepeat(repeat);
  const startMs = Date.parse(startUtc);
  if (!rule) return Number.isFinite(startMs) && startMs > afterMs ? startMs : null;
  const s = series(startUtc, timeZone, rule);
  if (!s) return null;
  let n = Math.max(0, Math.floor((afterMs - s.startMs) / s.period) - 2);
  for (let i = 0; i < MAX_STEPS; n++, i++) {
    const t = s.at(n);
    if (t == null || t <= afterMs) continue;
    return inRule(s, rule, n, t) ? t : null;
  }
  return null;
}
