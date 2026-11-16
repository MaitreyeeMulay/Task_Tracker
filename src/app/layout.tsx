import Link from "next/link";
import { cookies } from "next/headers";
import type { ReactNode } from "react";
import { getCurrentUser } from "@/auth/current-user";
import { logout } from "./login/actions";
import { NavLinks } from "./nav-links";
import { cycleThemeAction } from "./theme-actions";
import { parseTheme, THEME_COOKIE, type Theme } from "./ui";
import "./globals.css";

export const metadata = { title: "Incident tracker" };

const THEME_LABEL: Record<Theme, string> = { system: "Theme: auto", dark: "Theme: dark", light: "Theme: light" };

export default async function RootLayout({ children }: { children: ReactNode }) {
  const [user, jar] = await Promise.all([getCurrentUser(), cookies()]);
  const theme = parseTheme(jar.get(THEME_COOKIE)?.value);
  return (
    <html lang="en" data-theme={theme === "system" ? undefined : theme}>
      <body>
        <header className="topbar">
          <Link href={user ? "/incidents" : "/login"} className="brand">
            <span className="brand-mark" aria-hidden="true" />
            Incident tracker
          </Link>
          {user ? <NavLinks /> : null}
          <div className="topbar-end">
            <form action={cycleThemeAction}>
              <button type="submit" className="ghost small" title="Switch between automatic, dark and light">
                {THEME_LABEL[theme]}
              </button>
            </form>
            {user ? (
              <form action={logout} className="row">
                <span className="muted small">{user.name}</span>
                <button type="submit" className="ghost small">
                  Sign out
                </button>
              </form>
            ) : null}
          </div>
        </header>
        <div className="page">{children}</div>
      </body>
    </html>
  );
}
