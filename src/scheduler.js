/**
 * Scheduler Durable Object: precise one-time alarms for calendar/reminder/task due events.
 *
 * The DO is a dumb timer. It stores triggers {id -> {dueTimeMs, type, payload}},
 * sets a single alarm for the earliest due time, and on alarm() POSTs the due
 * triggers back to the Worker via the SELF service binding. The Worker does
 * the actual event emission using existing logic (dedupe, fanout, etc.).
 *
 * A per-minute cron sweep remains as a backfill safety net.
 */

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

  // Runtime calls this when the alarm fires
  async alarm() {
    const now = Date.now();
    const triggers = await this.getTriggers();
    const due = [];
    for (const [id, t] of triggers) {
      if (typeof t.dueTimeMs === "number" && t.dueTimeMs <= now) {
        due.push({ id, type: t.type, payload: t.payload });
        triggers.delete(id);
      }
    }
    if (due.length > 0) {
      await this.saveTriggers(triggers);
      // Hand off to the Worker for actual event emission
      try {
        const res = await this.env.SELF.fetch(
          new Request("https://internal/scheduler-due", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-scheduler-secret": this.env.SCHEDULER_SECRET || "",
            },
            body: JSON.stringify({ triggers: due }),
          })
        );
        if (!res.ok) {
          console.error(JSON.stringify({ msg: "scheduler handoff failed", status: res.status }));
        }
      } catch (err) {
        console.error(JSON.stringify({ msg: "scheduler handoff error", error: err && err.message }));
      }
    }
    await this.resetAlarm();
  }
}
