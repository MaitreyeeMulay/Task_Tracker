// Account lockout: 5 consecutive failed logins lock the account for 15 minutes.
// A successful login resets the counter (src/auth/login.ts).

export const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60_000;

export function lockoutAfterFailure(failedLogins: number, now: Date): { failedLogins: number; lockedUntil: Date | null } {
  const count = failedLogins + 1;
  return { failedLogins: count, lockedUntil: count >= MAX_FAILURES ? new Date(now.getTime() + LOCK_MS) : null };
}

export function isLocked(lockedUntil: Date | null, now: Date): boolean {
  return lockedUntil !== null && lockedUntil.getTime() > now.getTime();
}
