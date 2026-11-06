// Human-readable case numbers. The database assigns incidents.number from an
// identity sequence (unique, never reused); this only formats and parses it.

const PATTERN = /^INC-([1-9]\d{0,14})$/i;

export function formatCaseNumber(n: number): string {
  return `INC-${n}`;
}

export function parseCaseNumber(text: string): number | null {
  const match = PATTERN.exec(text.trim());
  return match?.[1] ? Number(match[1]) : null;
}
