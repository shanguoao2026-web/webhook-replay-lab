import { captureBody } from './body.js';
import { DEFAULT_REPLAY_TIMEOUT_MS, USER_AGENT } from './constants.js';
import type { Capture, ReplayResult } from './types.js';

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

const STRIP_HEADERS = new Set([
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
  'keep-alive',
  'upgrade',
  'proxy-connection',
  'te',
  'trailer',
  'proxy-authenticate',
  'proxy-authorization',
  'expect',
]);

export interface ReplayOptions {
  to: string;
  preserveHeaders?: boolean;
  timeoutMs?: number;
}

export function assertHttpUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`Invalid target URL: ${clip(input)}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Unsupported protocol: ${url.protocol}`);
  }
  if (!url.hostname) {
    throw new Error('Target URL is missing a host.');
  }
  return url;
}

export async function replayCapture(capture: Capture, options: ReplayOptions): Promise<ReplayResult> {
  const base = {
    id: capture.id,
    target: options.to,
    headers: {} as Record<string, string>,
    body: '',
  };

  let url: URL;
  try {
    url = assertHttpUrl(options.to);
  } catch (err) {
    return { ...base, ok: false, status: null, error: err instanceof Error ? err.message : String(err) };
  }

  const method = capture.method.toUpperCase();
  if (!/^[A-Z]+$/.test(method)) {
    return { ...base, ok: false, status: null, error: `Invalid method: ${clip(capture.method)}` };
  }

  const headers = buildHeaders(capture, options.preserveHeaders === true);
  const timeoutMs = options.timeoutMs ?? DEFAULT_REPLAY_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : new Uint8Array(captureBody(capture)),
      signal: controller.signal,
      redirect: 'manual',
    });
    const body = await response.text();
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });
    const status = response.status;
    return {
      ok: status >= 200 && status < 300,
      id: capture.id,
      target: options.to,
      status,
      headers: responseHeaders,
      body,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const aborted = err instanceof Error && err.name === 'AbortError';
    return {
      ...base,
      ok: false,
      status: null,
      error: aborted ? `timed out after ${timeoutMs}ms` : message,
    };
  } finally {
    clearTimeout(timer);
  }
}

function buildHeaders(capture: Capture, preserveHeaders: boolean): Record<string, string> {
  const headers: Record<string, string> = {};
  if (preserveHeaders) {
    for (const [key, value] of Object.entries(capture.headers)) {
      const lower = key.toLowerCase();
      if (STRIP_HEADERS.has(lower)) continue;
      assignHeader(headers, lower, Array.isArray(value) ? value.join(', ') : value);
    }
    return headers;
  }

  if (capture.contentType) assignHeader(headers, 'content-type', capture.contentType);
  assignHeader(headers, 'user-agent', USER_AGENT);
  assignHeader(headers, 'x-webhook-replay-id', capture.id);
  assignHeader(headers, 'x-webhook-replay-timestamp', capture.timestamp);
  assignHeader(headers, 'x-webhook-replay-path', capture.path);
  return headers;
}

/** Drop names or values that could split a request when a captured header is untrusted. */
function assignHeader(headers: Record<string, string>, name: string, value: string): void {
  if (!HEADER_NAME.test(name)) return;
  if (/[\u0000-\u001F\u007F]/.test(value)) return;
  headers[name] = value;
}

function clip(value: string): string {
  return value.length > 200 ? `${value.slice(0, 200)}…` : value;
}
