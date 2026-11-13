import type { ClientBase } from "pg";

export async function withForcedRlsLifted<T>(_client: ClientBase, _fn: () => Promise<T>): Promise<T> {
  throw new Error("not implemented");
}
