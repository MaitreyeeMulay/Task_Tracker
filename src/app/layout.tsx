import Link from "next/link";
import type { ReactNode } from "react";
import { getCurrentUser } from "@/auth/current-user";
import { logout } from "./login/actions";
import "./globals.css";

export const metadata = { title: "Incident tracker" };

export default async function RootLayout({ children }: { children: ReactNode }) {
  const user = await getCurrentUser();
  return (
    <html lang="en">
      <body>
        <header className="topbar">
          <strong>Incident tracker</strong>
          {user ? (
            <nav className="row">
              <Link href="/incidents">Incidents</Link>
              <Link href="/checklists">Checklists</Link>
              <Link href="/notifications">Review</Link>
              <Link href="/audit">Audit</Link>
            </nav>
          ) : null}
          {user ? (
            <form action={logout} className="row">
              <span className="muted">{user.name}</span>
              <button type="submit" className="link">
                Sign out
              </button>
            </form>
          ) : null}
        </header>
        <div className="page">{children}</div>
      </body>
    </html>
  );
}
