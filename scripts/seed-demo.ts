// Usage (AWS, one-off ECS task with the migration task definition):
//   node tools/scripts/seed-demo.ts
// Loads the dev seed's example teams, people, incidents and checklists into the
// live demo database, so there is something to log in to and screenshot.
// Runs as the database owner (DB_AUTH=secret). The demo accounts' password
// comes from DEMO_SEED_PASSWORD (random, in SSM); it is never printed.
// Safe to run twice.
import pg from "pg";
import { passwordProblem } from "../src/auth/password.ts";
import { seedAdmin, seedCore, seedRunbooks, setDemoPasswords } from "../src/db/demo-data.ts";
import { withForcedRlsLifted } from "../src/db/rls-lift.ts";
import { poolConfigFromEnv } from "../src/lib/aws.ts";

async function main(): Promise<void> {
  const password = process.env.DEMO_SEED_PASSWORD ?? "";
  const problem = passwordProblem(password);
  if (problem) throw new Error(`DEMO_SEED_PASSWORD rejected: ${problem}`);

  const client = new pg.Client({ ...poolConfigFromEnv(process.env), connectionTimeoutMillis: 15_000 });
  await client.connect();
  try {
    const accountsReady = await withForcedRlsLifted(client, async () => {
      await seedCore(client);
      await seedRunbooks(client);
      await seedAdmin(client);
      return setDemoPasswords(client, password);
    });
    console.log(JSON.stringify({ event: "demo_seed_done", accounts_ready: accountsReady }));
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ event: "demo_seed_failed", message: (error as Error).message }));
  process.exit(1);
});
