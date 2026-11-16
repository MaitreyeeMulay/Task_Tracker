// Pure helpers for the page chrome (theme switch, navigation).

export type Theme = "system" | "light" | "dark";

export const THEME_COOKIE = "theme";

/** Reads the theme cookie. Anything unexpected means "follow the system". */
export function parseTheme(value: string | undefined): Theme {
  return value === "light" || value === "dark" ? value : "system";
}

/** The header button cycles through the three settings. */
export function nextTheme(theme: Theme): Theme {
  return theme === "system" ? "dark" : theme === "dark" ? "light" : "system";
}

/** True when the nav link for `href` is the section the page belongs to. */
export function isActivePath(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}
