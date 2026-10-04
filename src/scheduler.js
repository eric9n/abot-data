/**
 * Scheduler Durable Object: precise one-time alarms for calendar/reminder/task due events.
 *
 * The DO is a dumb timer. It stores triggers {id -> {dueTimeMs, type, payload}},
 * sets a single alarm for the earliest due time, and on alarm() POSTs the due
 * triggers back to the Worker via the SELF service binding. The Worker does
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

export class Scheduler {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async getTriggers() {
    const stored = await this.state.storage.get("triggers");
    return stored instanceof Map ? stored : new Map(Object.entries(stored || {}));
  }

  async saveTriggers(triggers) {
    await this.state.storage.put("triggers", Object.fromEntries(triggers));
  }

  async resetAlarm() {
    const triggers = await this.getTriggers();
    let earliest = null;
    for (const t of triggers.values()) {
      if (typeof t.dueTimeMs !== "number") continue;
      if (earliest === null || t.dueTimeMs < earliest) earliest = t.dueTimeMs;
    }
    if (earliest !== null) {
      await this.state.storage.setAlarm(earliest);
    } else {
      await this.state.storage.deleteAlarm();
    }
  }

  // RPC: schedule (or reschedule) a trigger
  async schedule(id, dueTimeMs, type, payload) {
    if (typeof id !== "string" || !id) throw new Error("id required");
    if (!Number.isFinite(dueTimeMs)) throw new Error("dueTimeMs required");
    if (typeof type !== "string" || !type) throw new Error("type required");
    const triggers = await this.getTriggers();
    triggers.set(id, { dueTimeMs, type, payload: payload || null });
    await this.saveTriggers(triggers);
    await this.resetAlarm();
    return { ok: true };
  }

  // RPC: cancel a trigger
  async cancel(id) {
    const triggers = await this.getTriggers();
    const existed = triggers.delete(id);
    if (existed) {
      await this.saveTriggers(triggers);
      await this.resetAlarm();
    }
    return { ok: true, existed };
  }

  // Runtime calls this when the alarm fires. Due triggers are removed only
  // after the Worker accepts them; emission there is deduped, so a retry
  // after a partial failure cannot double-emit.
  async alarm() {
    const now = Date.now();
    const due = [];
    for (const [id, t] of await this.getTriggers()) {
      if (typeof t.dueTimeMs === "number" && t.dueTimeMs <= now) {
        due.push({ id, type: t.type, payload: t.payload, dueTimeMs: t.dueTimeMs });
      }
    }
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
          body: JSON.stringify({ triggers: due.map(({ id, type, payload }) => ({ id, type, payload })) }),
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
    // Re-read: schedule()/cancel() may have run while the handoff was in flight.
    const triggers = await this.getTriggers();
    for (const d of due) {
      const current = triggers.get(d.id);
      if (current && current.dueTimeMs === d.dueTimeMs) triggers.delete(d.id);
    }
    await this.saveTriggers(triggers);
    await this.resetAlarm();
  }
}
