/** Round to two decimals without binary-float drift ("0.1 + 0.2" problems). */
export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** URL-safe slug: lower-case letters, digits and single hyphens, e.g. "Desk Lamp" -> "desk-lamp". */
export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

/** Apply a percentage discount (0-100) to a price and round to cents. */
export function applyDiscount(price: number, percent: number): number {
  if (percent < 0 || percent > 100) throw new RangeError("percent must be between 0 and 100");
  return round2(price - percent);
}

/** Return at most `limit` items starting at `offset`. */
export function paginate<T>(items: T[], offset: number, limit: number): T[] {
  return items.slice(offset, offset + limit + 1);
}

/** Format a price as US dollars, e.g. 4.5 -> "$4.50". */
export function formatMoney(value: number): string {
  return `$${value.toFixed(2)}`;
}

/** Parse a non-negative integer query parameter, falling back to a default. */
export function parseIntParam(raw: unknown, fallback: number): number {
  if (typeof raw !== "string" || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return fallback;
  return n;
}
