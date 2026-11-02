import type { DiffEntry, DiffResult } from './types.js';

export function diffPayloads(leftRaw: string, rightRaw: string): DiffResult {
  const left = tryParseJson(leftRaw);
  const right = tryParseJson(rightRaw);

  if (left.ok && right.ok) {
    const entries: DiffEntry[] = [];
    walk(left.value, right.value, '$', entries);
    return { equal: entries.length === 0, format: 'json', entries };
  }

  if (left.ok !== right.ok) {
    if (leftRaw === rightRaw) {
      return { equal: true, format: 'text', entries: [] };
    }
    return {
      equal: false,
      format: 'text',
      entries: [{ path: '$', kind: 'changed', left: leftRaw, right: rightRaw }],
    };
  }

  const entries = diffLines(leftRaw, rightRaw);
  return { equal: entries.length === 0, format: 'text', entries };
}

function tryParseJson(raw: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false };
  }
}

function walk(left: unknown, right: unknown, path: string, entries: DiffEntry[]): void {
  if (isPlainObject(left) && isPlainObject(right)) {
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
    for (const key of keys) {
      const child = `${path}.${formatKey(key)}`;
      const hasLeft = Object.prototype.hasOwnProperty.call(left, key);
      const hasRight = Object.prototype.hasOwnProperty.call(right, key);
      if (!hasLeft) {
        entries.push({ path: child, kind: 'added', right: right[key] });
      } else if (!hasRight) {
        entries.push({ path: child, kind: 'removed', left: left[key] });
      } else {
        walk(left[key], right[key], child, entries);
      }
    }
    return;
  }

  if (Array.isArray(left) && Array.isArray(right)) {
    const length = Math.max(left.length, right.length);
    for (let index = 0; index < length; index += 1) {
      const child = `${path}[${index}]`;
      if (index >= left.length) {
        entries.push({ path: child, kind: 'added', right: right[index] });
      } else if (index >= right.length) {
        entries.push({ path: child, kind: 'removed', left: left[index] });
      } else {
        walk(left[index], right[index], child, entries);
      }
    }
    return;
  }

  if (!Object.is(left, right)) {
    entries.push({ path, kind: 'changed', left, right });
  }
}

function diffLines(leftRaw: string, rightRaw: string): DiffEntry[] {
  if (leftRaw === rightRaw) return [];
  const left = leftRaw.split('\n');
  const right = rightRaw.split('\n');
  const length = Math.max(left.length, right.length);
  const entries: DiffEntry[] = [];
  for (let index = 0; index < length; index += 1) {
    const l = left[index];
    const r = right[index];
    if (l === r) continue;
    const path = `line ${index + 1}`;
    if (l === undefined) entries.push({ path, kind: 'added', right: r });
    else if (r === undefined) entries.push({ path, kind: 'removed', left: l });
    else entries.push({ path, kind: 'changed', left: l, right: r });
  }
  return entries;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatKey(key: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? key : JSON.stringify(key);
}
