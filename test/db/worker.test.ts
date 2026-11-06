import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createStubProvider } from "../../src/notify/provider.ts";
import { fireDueTimers, runOnce, sendPending, sweepStaleSends } from "../../src/worker/worker.ts";

// M4 "done when": killing the worker mid-timer and mid-send, then restarting,
// loses nothing and sends nothing twice. Real Postgres, real child processes.

let pool: pg.Pool;
const T0 = new Date("2026-11-08T10:00:00Z");
const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);

beforeAll(() => {
  pool = new pg.Pool({ connectionString: inject("testDatabaseUrl"), max: 6 });
});

afterAll(async () => {
  await pool.end();
});

interface World {
  teamId: string;
  incidentId: string;
  responder: string;
  admin: string;
  viewer: string;
}

// Committed data (the worker commits), isolated by a unique team per test.
async function seed(severity = "SEV2"): Promise<World> {
  const tag = randomUUID().slice(0, 8);
  const { rows } = await pool.query(
    `WITH t AS (INSERT INTO teams (name) VALUES ($1) RETURNING id),
          r AS (INSERT INTO users (email, display_name) VALUES ($2, 'Rita') RETURNING id),
          a AS (INSERT INTO users (email, display_name) VALUES ($3, 'Adam') RETURNING id),
          v AS (INSERT INTO users (email, display_name) VALUES ($4, 'Vic') RETURNING id),
          m AS (INSERT INTO memberships (team_id, user_id, role)
                SELECT (SELECT id FROM t), (SELECT id FROM r), 'responder'
                UNION ALL SELECT (SELECT id FROM t), (SELECT id FROM a), 'admin'
                UNION ALL SELECT (SELECT id FROM t), (SELECT id FROM v), 'viewer'),
          s AS (INSERT INTO services (team_id, name) SELECT id, 'api' FROM t RETURNING id, team_id),
          i AS (INSERT INTO incidents (service_id, team_id, fingerprint, severity, title, opened_at, last_alert_at)
                SELECT id, team_id, $5, $6, 'API errors', $7, $7 FROM s RETURNING id)
     SELECT (SELECT id FROM t) AS "teamId", (SELECT id FROM i) AS "incidentId",
            (SELECT id FROM r) AS responder, (SELECT id FROM a) AS admin, (SELECT id FROM v) AS viewer`,
    [`w-${tag}`, `rita-${tag}@w.test`, `adam-${tag}@w.test`, `vic-${tag}@w.test`, `fp-${tag}`, severity, T0],
  );
  return rows[0];
}

async function timers(incidentId: string) {
  const { rows } = await pool.query(
    `SELECT kind, wake_at, fired_at IS NOT NULL AS fired, cancelled_at IS NOT NULL AS cancelled
     FROM timers WHERE incident_id = $1 ORDER BY kind, id`,
    [incidentId],
  );
  return rows;
}

async function notifications(incidentId: string) {
  const { rows } = await pool.query(
    `SELECT n.kind, n.level, u.display_name AS "to", n.status, n.attempts
     FROM notifications n JOIN users u ON u.id = n.recipient_user_id
     WHERE n.incident_id = $1 ORDER BY n.kind, u.display_name`,
    [incidentId],
  );
  return rows;
}

async function setStatus(incidentId: string, status: string) {
  await pool.query("UPDATE incidents SET status = $2 WHERE id = $1", [incidentId, status]);
}

async function fireAllDue(now: Date) {
  while ((await fireDueTimers(pool, { now })) > 0) {
    // keep going until nothing is due
  }
}

describe("durable SLA timers", () => {
  it("opening an incident schedules notify, ack and resolve timers from the SLA targets", async () => {
    const w = await seed("SEV2");
    expect(await timers(w.incidentId)).toEqual([
      { kind: "ack_due", wake_at: minutes(15), fired: false, cancelled: false },
      { kind: "notify_open", wake_at: T0, fired: false, cancelled: false },
      { kind: "resolve_due", wake_at: minutes(240), fired: false, cancelled: false },
    ]);
  });

  it("acknowledging cancels the ack timer; resolving cancels the resolve timer; reopening schedules a new one", async () => {
    const w = await seed();
    await setStatus(w.incidentId, "acknowledged");
    expect((await timers(w.incidentId)).find((t) => t.kind === "ack_due")?.cancelled).toBe(true);
    await setStatus(w.incidentId, "resolved");
    expect((await timers(w.incidentId)).filter((t) => t.kind === "resolve_due").map((t) => t.cancelled)).toEqual([true]);
    await setStatus(w.incidentId, "acknowledged");
    expect((await timers(w.incidentId)).filter((t) => t.kind === "resolve_due").map((t) => t.cancelled)).toEqual([true, false]);
  });
});

describe("timers fire into the notification outbox", () => {
  it("a new incident notifies the team's responders and admins, not viewers", async () => {
    const w = await seed();
    await fireAllDue(T0);
    expect(await notifications(w.incidentId)).toEqual([
      { kind: "incident_opened", level: 1, to: "Adam", status: "pending", attempts: 0 },
      { kind: "incident_opened", level: 1, to: "Rita", status: "pending", attempts: 0 },
    ]);
  });

  it("a missed acknowledgement escalates to admins and is recorded on the timeline", async () => {
    const w = await seed();
    await fireAllDue(minutes(16));
    expect((await notifications(w.incidentId)).filter((n) => n.kind === "ack_overdue")).toEqual([
      { kind: "ack_overdue", level: 2, to: "Adam", status: "pending", attempts: 0 },
    ]);
    const events = await pool.query("SELECT kind, data->>'text' AS text FROM incident_events WHERE incident_id = $1 AND kind = 'escalated'", [w.incidentId]);
    expect(events.rows).toEqual([{ kind: "escalated", text: "Not acknowledged within 15 min (SEV2): escalated to team admins" }]);
  });

  it("does not escalate once acknowledged", async () => {
    const w = await seed();
    await setStatus(w.incidentId, "acknowledged");
    await fireAllDue(minutes(16));
    expect((await notifications(w.incidentId)).filter((n) => n.kind === "ack_overdue")).toEqual([]);
  });

  it("a timer fires once even if asked twice", async () => {
    const w = await seed();
    await fireAllDue(minutes(16));
    await fireAllDue(minutes(17));
    expect((await notifications(w.incidentId)).filter((n) => n.kind === "ack_overdue")).toHaveLength(1);
  });
});

describe("sending", () => {
  it("delivers pending messages once and marks them sent", async () => {
    const w = await seed();
    await fireAllDue(T0);
    const stub = createStubProvider();
    while ((await sendPending(pool, stub.provider, { now: T0, workerId: "w1" })) > 0) {
      // drain
    }
    expect((await notifications(w.incidentId)).map((n) => n.status)).toEqual(["sent", "sent"]);
    expect(stub.sent.filter((m) => m.incidentId === w.incidentId)).toHaveLength(2);
  });

  it("retries a definite rejection later, and flags an ambiguous result for review", async () => {
    const w = await seed();
    await fireAllDue(T0);
    let call = 0;
    const flaky = async () => (++call === 1 ? { outcome: "rejected" as const, code: "Throttling" } : { outcome: "unknown" as const, code: "Timeout" });
    await sendPending(pool, flaky, { now: T0, workerId: "w1" });
    await sendPending(pool, flaky, { now: T0, workerId: "w1" });
    const states = (await notifications(w.incidentId)).map((n) => [n.status, n.attempts]);
    expect(states.sort()).toEqual([
      ["needs_review", 1],
      ["pending", 1],
    ]);
  });
});

// ----- Crash tests: real child processes, killed with SIGKILL -----

const CRASHER = fileURLToPath(new URL("./fixtures/crash-worker.ts", import.meta.url));

function runCrasher(mode: "mid-timer" | "mid-send", incidentId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CRASHER, mode, incidentId], {
      env: { ...process.env, TEST_DATABASE_URL: inject("testDatabaseUrl") },
      stdio: ["ignore", "pipe", "inherit"],
    });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("crasher never reached its crash point"));
    }, 15_000);
    child.stdout.on("data", (chunk: Buffer) => {
      // The child prints READY at the exact moment we want to crash it.
      if (chunk.toString().includes("READY")) {
        child.kill("SIGKILL");
      }
    });
    child.on("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

describe("killing the worker", () => {
  it("mid-timer: nothing is lost and nothing is doubled after restart", async () => {
    const w = await seed();
    await fireAllDue(T0); // the open notification, so only ack_due is left due at +16 min
    await runCrasher("mid-timer", w.incidentId); // dies holding the ack timer, before commit
    expect((await notifications(w.incidentId)).filter((n) => n.kind === "ack_overdue")).toEqual([]);

    await fireAllDue(minutes(16)); // "restart"
    await fireAllDue(minutes(17));
    expect((await notifications(w.incidentId)).filter((n) => n.kind === "ack_overdue")).toHaveLength(1);
    expect((await timers(w.incidentId)).find((t) => t.kind === "ack_due")?.fired).toBe(true);
  });

  it("mid-send: the message is flagged for a person, never sent again automatically", async () => {
    const w = await seed();
    await fireAllDue(T0);
    await runCrasher("mid-send", w.incidentId); // claims one message, starts sending, dies

    const stub = createStubProvider();
    const flagged = await sweepStaleSends(pool, { now: minutes(3), leaseMs: 30_000 });
    expect(flagged).toBeGreaterThanOrEqual(1);
    await runOnce(pool, stub.provider, { now: minutes(3), workerId: "w2", leaseMs: 30_000 });

    const states = (await notifications(w.incidentId)).map((n) => n.status).sort();
    expect(states).toEqual(["needs_review", "sent"]);
    // The crashed message was never handed to a provider again.
    expect(stub.sent.filter((m) => m.incidentId === w.incidentId)).toHaveLength(1);
  });
});
