"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { lookupUserIdByEmail, passwordLogin } from "@/auth/login";
import { createSessionToken, SESSION_COOKIE, sessionCookieOptions } from "@/auth/session";
import { loadConfig } from "@/lib/config";
import { getPool } from "@/lib/db";
import { clientAddress, loginByEmail, loginByIp } from "@/security/limits";

export interface LoginState {
  error?: string;
}

// One message for every failure (wrong password, unknown email, locked account,
// rate limited), so the form never reveals which accounts exist.
const FAILED = "Invalid email or password, or too many attempts. Try again in a few minutes.";

async function startSession(userId: string): Promise<never> {
  const config = loadConfig(process.env);
  const secret = config.sessionSecrets[0];
  if (!secret) throw new Error("SESSION_SECRET is not set");
  (await cookies()).set(SESSION_COOKIE, createSessionToken(userId, { secret, now: new Date() }), sessionCookieOptions(config.environment));
  redirect("/incidents");
}

/** Password login with lockout (5 failures lock 15 minutes) and rate limits. */
export async function passwordLoginAction(_previous: LoginState, formData: FormData): Promise<LoginState> {
  if (loadConfig(process.env).sessionSecrets.length === 0) return { error: "Sign-in is not configured." };
  const email = String(formData.get("email") ?? "").trim().toLowerCase().slice(0, 320);
  const password = String(formData.get("password") ?? "").slice(0, 200);

  const now = Date.now();
  const ip = clientAddress(await headers());
  if (!loginByIp.take(ip, now) || !loginByEmail.take(email, now)) {
    console.warn(JSON.stringify({ event: "login_rate_limited" }));
    return { error: FAILED };
  }

  const result = await passwordLogin(getPool(), { email, password, now: new Date(now) });
  if (!result.ok) return { error: FAILED };
  console.log(JSON.stringify({ event: "login", method: "password", user_id: result.userId }));
  return startSession(result.userId);
}

// Development-only login by email, no password. Disabled in production by
// config (tested in src/lib/config.test.ts). The lookup runs as app_auth.
export async function devLogin(_previous: LoginState, formData: FormData): Promise<LoginState> {
  const config = loadConfig(process.env);
  if (!config.devLoginEnabled || config.sessionSecrets.length === 0) return { error: "Dev login is disabled." };

  const userId = await lookupUserIdByEmail(getPool(), String(formData.get("email") ?? ""));
  if (!userId) return { error: "No user with that email." };
  console.log(JSON.stringify({ event: "login", method: "dev", user_id: userId }));
  return startSession(userId);
}

export async function logout(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/login");
}
