// Test helper for worker.test.ts: runs real worker code up to a crash point,
// prints READY, then waits forever so the parent can SIGKILL it there.
//   mid-timer: inside the timer transaction, after writing notifications, before COMMIT
//   mid-send:  after a message is claimed ("sending" committed), while the provider call is in flight
import pg from "pg";
import { fireDueTimers, sendPending } from "../../../src/worker/worker.ts";

const [mode, incidentId] = process.argv.slice(2);
if (!mode || !incidentId) throw new Error("usage: crash-worker.ts <mid-timer|mid-send> <incidentId>");
const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2 });
const hang = () => new Promise<never>(() => {});

if (mode === "mid-timer") {
  await fireDueTimers(pool, {
    now: new Date("2026-11-08T10:16:00Z"),
    onlyIncidentId: incidentId,
    beforeCommit: async () => {
      console.log("READY");
      await hang();
    },
  });
} else if (mode === "mid-send") {
  await sendPending(
    pool,
    async () => {
      console.log("READY");
      return hang();
    },
    { now: new Date("2026-11-08T10:01:00Z"), workerId: "crasher", onlyIncidentId: incidentId },
  );
}
