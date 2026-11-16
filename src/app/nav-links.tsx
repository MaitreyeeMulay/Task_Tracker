"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { isActivePath } from "./ui";

const LINKS = [
  { href: "/incidents", label: "Incidents" },
  { href: "/checklists", label: "Checklists" },
  { href: "/notifications", label: "Review" },
  { href: "/audit", label: "Audit" },
];

export function NavLinks() {
  const pathname = usePathname();
  return (
    <nav className="nav">
      {LINKS.map(({ href, label }) => {
        const active = isActivePath(pathname, href);
        return (
          <Link key={href} href={href} className={active ? "active" : undefined} aria-current={active ? "page" : undefined}>
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
