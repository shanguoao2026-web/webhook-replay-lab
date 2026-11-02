export function normalizeHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[key.toLowerCase()] = Array.isArray(value) ? value.map(String) : String(value);
  }
  return out;
}

/** Case-insensitive lookup. Array values use the first non-empty entry. */
export function getHeader(
  headers: Record<string, string | string[]>,
  name: string,
): string | null {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== target) continue;
    if (Array.isArray(value)) {
      const first = value.find((item) => item.trim() !== '');
      return first ?? null;
    }
    return value;
  }
  return null;
}
