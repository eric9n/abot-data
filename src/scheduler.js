/**
 * Scheduler Durable Object: precise one-time alarms for calendar/reminder/task due events.
 *
 * The DO is a dumb timer. It stores triggers in its SQLite table
 * triggers(id, due_ms, type, payload), sets a single alarm for the earliest
 * due time, and on alarm() POSTs the due triggers back to the Worker via the
 * SELF service binding. The Worker does
 * the actual event emission using existing logic (dedupe, fanout, etc.).
 *
 * The 5-minute cron sweep remains as a backfill safety net.
 *
 * Sharding: keep one object, idFromName("global"), rather than one DO per
 * owner. The DO stores {calendarId -> dueTime} and posts that id back to the
 * worker. The worker loads the calendar row and stamps calendar.due with that
 * row's owner_email, so this object never fans titles, places, or times out
 * to other tenants. A per-owner shard (idFromName(owner)) would cap one
 * tenant's alarm backlog and storage, but schedule and cancel must both use
 * the same name, and the cron sweep already backfills missed alarms. Revisit
 * sharding only if one owner's due volume starts delaying other alarms.
 */

// The Worker routes this exact path; the host is ignored by the SELF binding.
export const SCHEDULER_DUE_URL = "https://abot-data.internal/internal/scheduler-due";
const HANDOFF_RETRY_MS = 60_000;
export const HANDOFF_BATCH = 100;

export class Scheduler {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sql = state.storage.sql;
    state.blockConcurrencyWhile(() => this.migrate());
  }

  async migrate() {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS triggers (
      id TEXT PRIMARY KEY,
      due_ms INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload TEXT
    )`);
    this.sql.exec("CREATE INDEX IF NOT EXISTS idx_triggers_due ON triggers(due_ms)");
    // Objects created before the table kept every trigger in one "triggers" key.
    const stored = await this.state.storage.get("triggers");
    if (stored == null) return;
    const entries = stored instanceof Map ? [...stored] : Object.entries(stored);
    for (const [id, t] of entries) {
      if (!t || typeof t.dueTimeMs !== "number" || typeof t.type !== "string") continue;
      this.upsert(id, t.dueTimeMs, t.type, t.payload);
    }
    await this.state.storage.delete("triggers");
    await this.resetAlarm();
  }

  upsert(id, dueTimeMs, type, payload) {
    this.sql.exec(
      `INSERT INTO triggers (id, due_ms, type, payload) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET due_ms = excluded.due_ms, type = excluded.type, payload = excluded.payload`,
      id,
      dueTimeMs,
      type,
      JSON.stringify(payload ?? null),
    );
  }

  async getTriggers() {
    const rows = this.sql.exec("SELECT id, due_ms, type, payload FROM triggers ORDER BY due_ms, id").toArray();
    return new Map(rows.map((r) => [r.id, { dueTimeMs: r.due_ms, type: r.type, payload: JSON.parse(r.payload) }]));
  }

  async resetAlarm() {
    const [row] = this.sql.exec("SELECT MIN(due_ms) AS earliest FROM triggers").toArray();
    if (row && row.earliest != null) {
      await this.state.storage.setAlarm(row.earliest);
    } else {
      await this.state.storage.deleteAlarm();
    }
  }

  // RPC: schedule (or reschedule) a trigger
  async schedule(id, dueTimeMs, type, payload) {
    if (typeof id !== "string" || !id) throw new Error("id required");
    if (!Number.isFinite(dueTimeMs)) throw new Error("dueTimeMs required");
    if (typeof type !== "string" || !type) throw new Error("type required");
    this.upsert(id, dueTimeMs, type, payload || null);
    await this.resetAlarm();
    return { ok: true };
  }

  // RPC: cancel a trigger
  async cancel(id) {
    const existed = this.sql.exec("DELETE FROM triggers WHERE id = ? RETURNING id", id).toArray().length > 0;
    if (existed) await this.resetAlarm();
    return { ok: true, existed };
  }

  // Runtime calls this when the alarm fires. Due triggers are removed only
  // after the Worker accepts them; emission there is deduped, so a retry
  // after a partial failure cannot double-emit. A full batch leaves the alarm
  // at the next due time, which is already past, so the rest follow at once.
  async alarm() {
    const due = this.sql
      .exec(
        "SELECT id, due_ms, type, payload FROM triggers WHERE due_ms <= ? ORDER BY due_ms, id LIMIT ?",
        Date.now(),
        HANDOFF_BATCH,
      )
      .toArray();
    if (due.length === 0) {
      await this.resetAlarm();
      return;
    }
    let ok = false;
    try {
      const res = await this.env.SELF.fetch(
        new Request(SCHEDULER_DUE_URL, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-scheduler-secret": this.env.SCHEDULER_SECRET || "",
          },
          body: JSON.stringify({
            triggers: due.map((d) => ({ id: d.id, type: d.type, payload: JSON.parse(d.payload) })),
          }),
        })
      );
      ok = res.ok;
      if (!ok) console.error(JSON.stringify({ msg: "scheduler handoff failed", status: res.status }));
    } catch (err) {
      console.error(JSON.stringify({ msg: "scheduler handoff error", error: err && err.message }));
    }
    if (!ok) {
      await this.state.storage.setAlarm(Date.now() + HANDOFF_RETRY_MS);
      return;
    }
    // schedule()/cancel() may have run while the handoff was in flight.
    for (const d of due) {
      this.sql.exec("DELETE FROM triggers WHERE id = ? AND due_ms = ?", d.id, d.due_ms);
    }
    await this.resetAlarm();
  }
}
