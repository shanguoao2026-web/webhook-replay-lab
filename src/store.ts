import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertSafeId, isSafeId } from './ids.js';
import type { Capture } from './types.js';

function isEnoent(err: unknown): boolean {
  return Boolean(err) && typeof err === 'object' && (err as { code?: string }).code === 'ENOENT';
}

export async function ensureDir(dir: string): Promise<string> {
  const abs = path.resolve(dir);
  await mkdir(abs, { recursive: true });
  return abs;
}

export async function saveCapture(dir: string, capture: Capture): Promise<string> {
  assertSafeId(capture.id);
  const abs = await ensureDir(dir);
  const target = path.join(abs, `${capture.id}.json`);
  const tmp = path.join(abs, `.${capture.id}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`);
  const payload = JSON.stringify(orderCapture(capture), null, 2) + '\n';
  try {
    await writeFile(tmp, payload, 'utf8');
    await rename(tmp, target);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
  return target;
}

export async function readCapture(dir: string, id: string): Promise<Capture> {
  assertSafeId(id);
  const file = path.join(path.resolve(dir), `${id}.json`);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if (isEnoent(err)) throw new Error(`Capture not found: ${id}`);
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Invalid capture file: ${id}.json`);
  }
  const capture = parseCapture(parsed, `${id}.json`);
  if (capture.id !== id) {
    throw new Error(`Capture id mismatch in ${id}.json`);
  }
  return capture;
}

export async function listCaptures(dir: string): Promise<Capture[]> {
  const abs = path.resolve(dir);
  let names: string[];
  try {
    const stat = await lstat(abs);
    if (!stat.isDirectory()) {
      throw new Error(`Capture path is not a directory: ${abs}`);
    }
    names = await readdir(abs);
  } catch (err) {
    if (isEnoent(err)) return [];
    throw err;
  }

  const captures: Capture[] = [];
  for (const name of names) {
    if (!name.endsWith('.json') || name.startsWith('.')) continue;
    const id = name.slice(0, -'.json'.length);
    if (!isSafeId(id)) {
      throw new Error(`Invalid capture file name: ${name}`);
    }
    captures.push(await readCapture(abs, id));
  }

  captures.sort((a, b) => {
    const delta = Date.parse(b.timestamp) - Date.parse(a.timestamp);
    if (delta !== 0) return delta;
    return b.id.localeCompare(a.id);
  });
  return captures;
}

function orderCapture(capture: Capture): Capture {
  const ordered: Capture = {
    id: capture.id,
    timestamp: capture.timestamp,
    method: capture.method,
    path: capture.path,
    query: capture.query,
    headers: capture.headers,
    rawBody: capture.rawBody,
    contentType: capture.contentType,
    remoteAddr: capture.remoteAddr,
  };
  if (capture.bodyEncoding === 'base64') ordered.bodyEncoding = 'base64';
  return ordered;
}

function parseCapture(value: unknown, filename: string): Capture {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid capture file: ${filename}`);
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || !isSafeId(record.id)) {
    throw new Error(`Invalid capture file: ${filename} (id)`);
  }
  if (typeof record.timestamp !== 'string' || Number.isNaN(Date.parse(record.timestamp))) {
    throw new Error(`Invalid capture file: ${filename} (timestamp)`);
  }
  if (typeof record.method !== 'string' || !/^[A-Za-z]+$/.test(record.method)) {
    throw new Error(`Invalid capture file: ${filename} (method)`);
  }
  if (typeof record.path !== 'string' || !record.path.startsWith('/')) {
    throw new Error(`Invalid capture file: ${filename} (path)`);
  }
  if (typeof record.rawBody !== 'string') {
    throw new Error(`Invalid capture file: ${filename} (rawBody)`);
  }
  if (!record.headers || typeof record.headers !== 'object' || Array.isArray(record.headers)) {
    throw new Error(`Invalid capture file: ${filename} (headers)`);
  }

  const headers: Record<string, string | string[]> = {};
  for (const [key, item] of Object.entries(record.headers as Record<string, unknown>)) {
    if (typeof item === 'string') {
      headers[key] = item;
    } else if (Array.isArray(item) && item.every((entry) => typeof entry === 'string')) {
      headers[key] = item;
    } else {
      throw new Error(`Invalid capture file: ${filename} (header ${key})`);
    }
  }

  if (!(record.contentType === null || typeof record.contentType === 'string')) {
    throw new Error(`Invalid capture file: ${filename} (contentType)`);
  }
  if (!(record.remoteAddr === null || typeof record.remoteAddr === 'string')) {
    throw new Error(`Invalid capture file: ${filename} (remoteAddr)`);
  }
  const query = record.query === undefined ? '' : record.query;
  if (typeof query !== 'string') {
    throw new Error(`Invalid capture file: ${filename} (query)`);
  }
  if (
    record.bodyEncoding !== undefined &&
    record.bodyEncoding !== 'utf8' &&
    record.bodyEncoding !== 'base64'
  ) {
    throw new Error(`Invalid capture file: ${filename} (bodyEncoding)`);
  }

  const capture: Capture = {
    id: record.id,
    timestamp: record.timestamp,
    method: record.method,
    path: record.path,
    query,
    headers,
    rawBody: record.rawBody,
    contentType: record.contentType,
    remoteAddr: record.remoteAddr,
  };
  if (record.bodyEncoding === 'base64') capture.bodyEncoding = 'base64';
  return capture;
}
