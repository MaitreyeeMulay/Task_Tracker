export interface HealthResult {
  httpStatus: number;
  body: { status: "ok" | "degraded"; db: "ok" | "down" };
}

export function buildHealth({ dbOk }: { dbOk: boolean }): HealthResult {
  return dbOk
    ? { httpStatus: 200, body: { status: "ok", db: "ok" } }
    : { httpStatus: 503, body: { status: "degraded", db: "down" } };
}
