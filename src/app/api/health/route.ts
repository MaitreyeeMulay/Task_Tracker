import { pingDb } from "@/lib/db";
import { buildHealth } from "@/lib/health";

export const dynamic = "force-dynamic";

export async function GET() {
  const { httpStatus, body } = buildHealth({ dbOk: await pingDb() });
  return Response.json(body, { status: httpStatus, headers: { "Cache-Control": "no-store" } });
}
