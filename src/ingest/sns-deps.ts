import type { Pool } from "pg";
import { verifySnsMessage } from "./sns.ts";
import type { CertFetcher, SubscriptionConfirmer } from "./sns-http.ts";
import type { SnsHandlerDeps } from "./sns-handler.ts";
import { findSnsIntegration, ingestAlert, withIngestRole } from "./store.ts";

// Wires the handler to Postgres. Each DB step is its own short transaction as
// app_ingest, so no transaction stays open during the certificate fetch.
export function createSnsDeps(options: {
  pool: Pool;
  fetchCert: CertFetcher;
  confirmSubscription: SubscriptionConfirmer;
  log?: (event: Record<string, string | number>) => void;
}): SnsHandlerDeps {
  const { pool, fetchCert, confirmSubscription } = options;

  async function inIngestTransaction<T>(fn: (client: import("pg").PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      return await withIngestRole(client, () => fn(client));
    } finally {
      client.release();
    }
  }

  return {
    findIntegration: (id) => inIngestTransaction((client) => findSnsIntegration(client, id)),
    verify: (message, expectedTopicArn) => verifySnsMessage(message, { expectedTopicArn, fetchCert }),
    confirmSubscription,
    ingest: (integration, alert, payload) => inIngestTransaction((client) => ingestAlert(client, integration, alert, payload)),
    log: options.log ?? ((event) => console.log(JSON.stringify(event))),
  };
}
