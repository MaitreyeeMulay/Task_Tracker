"use server";

import { cookies } from "next/headers";
import { loadConfig } from "@/lib/config";
import { nextTheme, parseTheme, THEME_COOKIE } from "./ui";

/** Header button: system → dark → light. Stored in a cookie so the server renders the right theme (no inline script, strict CSP). */
export async function cycleThemeAction(): Promise<void> {
  const jar = await cookies();
  const theme = nextTheme(parseTheme(jar.get(THEME_COOKIE)?.value));
  jar.set(THEME_COOKIE, theme, {
    httpOnly: true,
    sameSite: "lax",
    secure: loadConfig(process.env).environment === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
}
