import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { captureBody, encodeBody } from './body.js';
import { DEFAULT_HOST, DEFAULT_MAX_BODY_BYTES, VERSION } from './constants.js';
import { toCurl } from './curl.js';
import { normalizeHeaders } from './headers.js';
import { createId } from './ids.js';
import { assertHttpUrl, replayCapture } from './replay.js';
import { listCaptures, readCapture, saveCapture } from './store.js';
import type { Capture, CaptureSummary } from './types.js';
import { renderUiPage } from './ui.js';

const API_JSON_LIMIT = 64 * 1024;

export interface ServerOptions {
  port: number;
  host?: string;
  dir: string;
  ui?: boolean;
  maxBodyBytes?: number;
}

export interface RunningServer {
  port: number;
  host: string;
  url: string;
  close: () => Promise<void>;
}

interface Context {
  dir: string;
  ui: boolean;
  maxBodyBytes: number;
  baseUrl: () => string;
}

class HttpError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export function startServer(options: ServerOptions): Promise<RunningServer> {
  const host = options.host ?? DEFAULT_HOST;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const state = { baseUrl: '' };
  const ctx: Context = {
    dir: options.dir,
    ui: options.ui === true,
    maxBodyBytes,
    baseUrl: () => state.baseUrl,
  };

  const server = http.createServer((req, res) => {
    void handle(req, res, ctx).catch((err: unknown) => {
      if (res.headersSent || res.writableEnded) return;
      const detail = err instanceof Error ? err.message : String(err);
      process.stderr.write(`error: ${detail}\n`);
      sendJson(res, 500, { ok: false, error: 'Internal error.' });
    });
  });

  return new Promise((resolve, reject) => {
    const onListenError = (err: Error) => reject(err);
    server.once('error', onListenError);
    server.listen(options.port, host, () => {
      server.off('error', onListenError);
      server.on('error', (err) => {
        process.stderr.write(`server error: ${err.message}\n`);
      });
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : options.port;
      state.baseUrl = publicOrigin(host, port);
      resolve({
        host,
        port,
        url: state.baseUrl,
        close: () =>
          new Promise((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          }),
      });
    });
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, ctx: Context): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://127.0.0.1');
  } catch {
    sendJson(res, 400, { ok: false, error: 'Bad request URL.' });
    return;
  }

  try {
    await route(req, res, ctx, method, url);
  } catch (err) {
    if (res.headersSent || res.writableEnded) return;
    const mapped = mapError(err);
    if (mapped.status >= 500) {
      const detail = err instanceof Error ? err.message : String(err);
      process.stderr.write(`error: ${detail}\n`);
    }
    sendJson(
      res,
      mapped.status,
      { ok: false, error: mapped.message },
      mapped.status === 413 ? { connection: 'close' } : {},
    );
  }
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: Context,
  method: string,
  url: URL,
): Promise<void> {
  const { pathname } = url;

  if (method === 'GET' && pathname === '/health') {
    sendJson(res, 200, { ok: true, service: 'webhook-replay-lab', version: VERSION });
    return;
  }
  if (method === 'GET' && pathname === '/favicon.ico') {
    res.writeHead(204, { 'cache-control': 'no-store' });
    res.end();
    return;
  }
  if (method === 'GET' && pathname === '/api/captures') {
    const captures = await listCaptures(ctx.dir);
    sendJson(res, 200, { ok: true, captures: captures.map(summarize) });
    return;
  }

  const replayId = idFrom(pathname, /^\/api\/captures\/([A-Za-z0-9_-]+)\/replay$/);
  if (replayId && method === 'POST') {
    await handleReplay(replayId, req, res, ctx);
    return;
  }
  const curlId = idFrom(pathname, /^\/api\/captures\/([A-Za-z0-9_-]+)\/curl$/);
  if (curlId && method === 'GET') {
    await handleCurl(curlId, url, res, ctx);
    return;
  }
  const oneId = idFrom(pathname, /^\/api\/captures\/([A-Za-z0-9_-]+)$/);
  if (oneId && method === 'GET') {
    const capture = await readCapture(ctx.dir, oneId);
    sendJson(res, 200, { ok: true, capture });
    return;
  }

  if (method === 'GET' && pathname === '/') {
    if (ctx.ui) {
      sendHtml(res, renderUiPage());
      return;
    }
    sendText(res, 200, 'webhook-replay-lab\nstatus: listening\nui: disabled\n');
    return;
  }

  if (pathname === '/api' || pathname.startsWith('/api/')) {
    throw new HttpError('Not found.', 404);
  }

  await captureRequest(req, res, ctx, method, url);
}

async function handleReplay(
  id: string,
  req: IncomingMessage,
  res: ServerResponse,
  ctx: Context,
): Promise<void> {
  const capture = await readCapture(ctx.dir, id);
  const raw = await readBody(req, API_JSON_LIMIT);
  let parsed: unknown = {};
  if (raw.length > 0) {
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new HttpError('Replay body must be JSON.', 400);
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError('Replay body must be a JSON object.', 400);
  }
  const body = parsed as { to?: unknown; preserveHeaders?: unknown; timeoutMs?: unknown };
  if (typeof body.to !== 'string' || body.to.trim() === '') {
    throw new HttpError('Field "to" must be a URL.', 400);
  }
  const timeoutMs = body.timeoutMs === undefined ? undefined : body.timeoutMs;
  if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new HttpError('Field "timeoutMs" must be a positive number.', 400);
  }
  const result = await replayCapture(capture, {
    to: body.to.trim(),
    preserveHeaders: body.preserveHeaders === true,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  sendJson(res, 200, result);
}

async function handleCurl(id: string, url: URL, res: ServerResponse, ctx: Context): Promise<void> {
  const capture = await readCapture(ctx.dir, id);
  const requested = url.searchParams.get('to');
  let target: string;
  if (requested && requested.trim()) {
    target = assertHttpUrl(requested.trim()).toString();
  } else {
    const suffix = capture.query ? `?${capture.query}` : '';
    target = `${ctx.baseUrl()}${capture.path}${suffix}`;
  }
  sendJson(res, 200, { ok: true, curl: toCurl(capture, target) });
}

async function captureRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: Context,
  method: string,
  url: URL,
): Promise<void> {
  const body = await readBody(req, ctx.maxBodyBytes);
  const encoded = encodeBody(body);
  const headers = normalizeHeaders(req.headers);
  const contentType = headerString(headers['content-type']);
  const capture: Capture = {
    id: createId(),
    timestamp: new Date().toISOString(),
    method,
    path: url.pathname,
    query: url.search.startsWith('?') ? url.search.slice(1) : '',
    headers,
    rawBody: encoded.rawBody,
    contentType,
    remoteAddr: req.socket.remoteAddress ?? null,
  };
  if (encoded.bodyEncoding === 'base64') capture.bodyEncoding = 'base64';
  await saveCapture(ctx.dir, capture);
  process.stdout.write(`captured ${capture.id} ${capture.method} ${capture.path} ${body.length}b\n`);
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-webhook-replay-id': capture.id,
  });
  res.end(JSON.stringify({ ok: true, id: capture.id }));
}

function summarize(capture: Capture): CaptureSummary {
  return {
    id: capture.id,
    timestamp: capture.timestamp,
    method: capture.method,
    path: capture.path,
    query: capture.query,
    contentType: capture.contentType,
    remoteAddr: capture.remoteAddr,
    bytes: captureBody(capture).length,
  };
}

function headerString(value: string | string[] | undefined): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value[0] ?? null;
  return null;
}

function idFrom(pathname: string, pattern: RegExp): string | null {
  const match = pathname.match(pattern);
  return match?.[1] ?? null;
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (err: Error | null, buf?: Buffer): void => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(buf ?? Buffer.alloc(0));
    };
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        req.pause();
        finish(new HttpError(`Payload exceeds ${limit} bytes.`, 413));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish(null, Buffer.concat(chunks)));
    req.on('error', () => {
      if (!settled) finish(new HttpError('Request body could not be read.', 400));
    });
    req.on('close', () => {
      if (!settled && !req.complete) finish(new HttpError('Client closed the request.', 400));
    });
  });
}

function mapError(err: unknown): { status: number; message: string } {
  if (err instanceof HttpError) return { status: err.statusCode, message: err.message };
  if (err instanceof Error) {
    if (err.message.startsWith('Capture not found')) return { status: 404, message: err.message };
    if (
      err.message === 'Invalid capture id.' ||
      err.message.startsWith('Invalid capture') ||
      err.message.startsWith('Invalid target URL') ||
      err.message.startsWith('Unsupported protocol') ||
      err.message.startsWith('Target URL')
    ) {
      return { status: 400, message: err.message };
    }
  }
  return { status: 500, message: 'Internal error.' };
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extra: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-length': Buffer.byteLength(payload),
    ...extra,
  });
  res.end(payload);
}

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy':
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'none'; connect-src 'self'; base-uri 'none'; form-action 'self'",
  });
  res.end(html);
}

function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(text);
}

function publicOrigin(host: string, port: number): string {
  const shown = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  if (shown.includes(':') && !shown.startsWith('[')) return `http://[${shown}]:${port}`;
  return `http://${shown}:${port}`;
}
