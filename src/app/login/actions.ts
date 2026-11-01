"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createSessionToken, SESSION_COOKIE, sessionCookieOptions } from "@/auth/session";
import { loadConfig } from "@/lib/config";
import { getPool } from "@/lib/db";

export interface LoginState {
  error?: string;
}

// Development-only login by email, no password. Disabled in production by
// config (tested in src/lib/config.test.ts); production uses OIDC (M5, not built).
// The lookup runs before any user exists in the session, so it is the one query
// that does not go through withUser; it reads a single id by email.
export async function devLogin(_previous: LoginState, formData: FormData): Promise<LoginState> {
  const config = loadConfig(process.env);
  const secret = config.sessionSecrets[0];
  if (!config.devLoginEnabled || !secret) return { error: "Dev login is disabled." };

  const email = String(formData.get("email") ?? "").trim().slice(0, 320);
  const { rows } = await getPool().query<{ id: string }>("SELECT id FROM users WHERE lower(email) = lower($1)", [email]);
  const user = rows[0];
  if (!user) return { error: "No user with that email." };

  (await cookies()).set(SESSION_COOKIE, createSessionToken(user.id, { secret, now: new Date() }), sessionCookieOptions(config.environment));
  console.log(JSON.stringify({ event: "dev_login", user_id: user.id }));
  redirect("/incidents");
}

export async function logout(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/login");
}
