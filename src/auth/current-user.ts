import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { loadConfig } from "@/lib/config";
import { getPool } from "@/lib/db";
import { withUser } from "@/db/with-user";
import { SESSION_COOKIE, verifySessionToken } from "./session";

export interface CurrentUser {
  id: string;
  name: string;
}

/** The signed-in user, or null. The profile is read as that user, through RLS. */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  const { sessionSecrets } = loadConfig(process.env);
  if (sessionSecrets.length === 0) return null;
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const session = verifySessionToken(token, { secrets: sessionSecrets, now: new Date() });
  if (!session) return null;
  return withUser(getPool(), session.userId, async (db) => {
    const { rows } = await db.query<CurrentUser>("SELECT id, display_name AS name FROM users WHERE id = app_user_id()");
    return rows[0] ?? null;
  });
}

export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}
