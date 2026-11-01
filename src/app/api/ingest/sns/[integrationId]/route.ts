import { loadConfig } from "@/lib/config";
import { getPool } from "@/lib/db";
import { createSnsDeps } from "@/ingest/sns-deps";
import { handleSnsIngest, readBodyLimited } from "@/ingest/sns-handler";
import { createCertFetcher, createStubSubscriptionConfirmer, createSubscriptionConfirmer } from "@/ingest/sns-http";

export const dynamic = "force-dynamic";

// SNS messages are at most 256 KB; leave headroom for the JSON envelope.
const MAX_BODY_BYTES = 300 * 1024;

const config = loadConfig(process.env);
const deps = createSnsDeps({
  pool: getPool(),
  fetchCert: createCertFetcher(),
  // Real subscription confirmation only in production; a stub elsewhere.
  confirmSubscription: config.environment === "production" ? createSubscriptionConfirmer() : createStubSubscriptionConfirmer(),
});

export async function POST(request: Request, { params }: { params: Promise<{ integrationId: string }> }) {
  const { integrationId } = await params;
  const body = await readBodyLimited(request, MAX_BODY_BYTES);
  const result = await handleSnsIngest({ integrationId, body }, deps);
  return Response.json(result.body, { status: result.status, headers: { "Cache-Control": "no-store" } });
}
