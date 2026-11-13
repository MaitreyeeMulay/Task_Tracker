// Usage: npm run worker            (runs until Ctrl+C / SIGTERM)
//        npm run worker -- --once  (one pass, then exits; for cron or a quick check)
// Fires SLA timers, escalates, and sends notifications from the outbox.
// Safe to run more than one copy: work is claimed with FOR UPDATE SKIP LOCKED.
import { hostname } from "node:os";
import pg from "pg";
import { createSesSend, poolConfigFromEnv } from "../src/lib/aws.ts";
import { createStubProvider, type EmailProvider } from "../src/notify/provider.ts";
import { createSesProvider } from "../src/notify/ses.ts";
import { runOnce } from "../src/worker/worker.ts";

const INTERVAL_MS = 5_000;
// A message still "sending" after this long means its worker died mid-send.
const LEASE_MS = 60_000;

const providerName = process.env.EMAIL_PROVIDER ?? "stub";
function emailProvider(): EmailProvider {
  if (providerName === "stub") return createStubProvider().provider;
  if (providerName !== "ses") throw new Error("EMAIL_PROVIDER must be stub or ses.");
  const { AWS_REGION: region, EMAIL_FROM: from } = process.env;
  if (!region || !from) throw new Error("EMAIL_PROVIDER=ses needs AWS_REGION and EMAIL_FROM.");
  return createSesProvider({ send: createSesSend(region), from });
}

const pool = new pg.Pool({ ...poolConfigFromEnv(process.env), max: 4, connectionTimeoutMillis: 15_000 });
const provider = emailProvider();
const workerId = `${hostname()}-${process.pid}`;
const once = process.argv.includes("--once");
let stopping = false;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopping = true;
    console.log(JSON.stringify({ event: "worker_stopping", signal }));
  });
}

// A log line per minute after a successful pass. A CloudWatch metric filter
// counts these, and the "worker silent" alarm fires when they stop (M6).
const HEARTBEAT_LOG_MS = 60_000;
let lastHeartbeatLog = 0;

console.log(JSON.stringify({ event: "worker_started", worker_id: workerId, provider: providerName }));
while (!stopping) {
  try {
    const result = await runOnce(pool, provider, { now: new Date(), workerId, leaseMs: LEASE_MS });
    if (result.fired || result.sent || result.flagged) console.log(JSON.stringify({ event: "worker_pass", ...result }));
    if (Date.now() - lastHeartbeatLog >= HEARTBEAT_LOG_MS) {
      console.log(JSON.stringify({ event: "worker_heartbeat", worker_id: workerId }));
      lastHeartbeatLog = Date.now();
    }
  } catch (error) {
    // Log the code only; the next pass retries reading, never a send.
    console.error(JSON.stringify({ event: "worker_pass_failed", code: (error as { code?: string }).code ?? "unknown" }));
  }
  if (once) break;
  await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
}
await pool.end();
console.log(JSON.stringify({ event: "worker_stopped" }));
