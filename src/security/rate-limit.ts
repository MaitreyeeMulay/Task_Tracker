// Fixed-window rate limiter kept in memory. It protects a single app instance;
// with several instances each enforces its own limit (documented trade-off;
// a shared store would be needed for a strict global limit).

export function createRateLimiter({ limit, windowMs, maxKeys = 10_000 }: { limit: number; windowMs: number; maxKeys?: number }) {
  const windows = new Map<string, { start: number; count: number }>();

  function take(key: string, nowMs: number): boolean {
    const current = windows.get(key);
    if (!current || nowMs - current.start >= windowMs) {
      if (!current && windows.size >= maxKeys) {
        // Bounded memory: drop the oldest key (Map keeps insertion order).
        const oldest = windows.keys().next().value;
        if (oldest !== undefined) windows.delete(oldest);
      }
      windows.delete(key);
      windows.set(key, { start: nowMs, count: 1 });
      return true;
    }
    if (current.count >= limit) return false;
    current.count++;
    return true;
  }

  return { take, size: () => windows.size };
}
