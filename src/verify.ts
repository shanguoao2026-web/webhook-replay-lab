import { createHmac, timingSafeEqual } from 'node:crypto';
import { captureBody } from './body.js';
import { DEFAULT_HMAC_HEADER, DEFAULT_HMAC_PREFIX, DEFAULT_STRIPE_HEADER, DEFAULT_TOLERANCE_SEC } from './constants.js';
import { getHeader } from './headers.js';
import type { Capture, VerifyResult } from './types.js';

export interface StripeVerifyOptions {
  secret: string;
  /** Seconds. Values greater than 0 reject signatures older than this. 0 disables the check (Stripe-compatible). */
  toleranceSec?: number;
  /** Unix seconds. Defaults to the current time. */
  nowSec?: number;
  headerName?: string;
}

export interface HmacVerifyOptions {
  secret: string;
  headerName?: string;
  /** Set to an empty string to compare a raw hex digest. Default `sha256=`. */
  prefix?: string;
}

/**
 * Stripe signs the bytes of `${timestamp}.${rawBody}` with HMAC-SHA256.
 * The header looks like `t=<unix>,v1=<hex>`. Every `v1` value is checked so
 * a rotated signing secret still matches one of them. `v0` is ignored.
 *
 * The age check matches Stripe's libraries: when tolerance is greater than 0,
 * a timestamp older than the tolerance fails. A tolerance of 0 skips the
 * check. Timestamps in the future are accepted.
 */
export function verifyStripe(capture: Capture, options: StripeVerifyOptions): VerifyResult {
  if (!options.secret) {
    return { ok: false, provider: 'stripe', reason: 'secret is empty' };
  }
  const tolerance = options.toleranceSec ?? DEFAULT_TOLERANCE_SEC;
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    throw new Error('Stripe tolerance must be a non-negative number of seconds.');
  }

  const headerName = options.headerName ?? DEFAULT_STRIPE_HEADER;
  const header = getHeader(capture.headers, headerName);
  if (!header) {
    return { ok: false, provider: 'stripe', reason: `missing ${headerName} header` };
  }

  const parsed = parseStripeSignature(header);
  if (!parsed) {
    return { ok: false, provider: 'stripe', reason: 'malformed Stripe-Signature header' };
  }

  const expected = stripeDigest(options.secret, parsed.timestamp, capture);
  const match = parsed.v1.some((signature) => safeEqualHex(expected, signature));
  if (!match) {
    return {
      ok: false,
      provider: 'stripe',
      reason: 'signature mismatch',
      timestamp: parsed.timestamp,
    };
  }

  const now = options.nowSec ?? Math.floor(Date.now() / 1000);
  const age = now - parsed.timestamp;
  if (tolerance > 0 && age > tolerance) {
    return {
      ok: false,
      provider: 'stripe',
      reason: `timestamp outside tolerance (${age}s > ${tolerance}s)`,
      timestamp: parsed.timestamp,
    };
  }

  return { ok: true, provider: 'stripe', reason: 'signature valid', timestamp: parsed.timestamp };
}

/**
 * Shared-secret HMAC-SHA256 over the raw body bytes.
 * Default header: `X-Hub-Signature-256: sha256=<hex>`.
 */
export function verifyHmac(capture: Capture, options: HmacVerifyOptions): VerifyResult {
  if (!options.secret) {
    return { ok: false, provider: 'hmac', reason: 'secret is empty' };
  }
  const headerName = options.headerName ?? DEFAULT_HMAC_HEADER;
  const header = getHeader(capture.headers, headerName);
  if (!header) {
    return { ok: false, provider: 'hmac', reason: `missing ${headerName} header` };
  }

  const prefix = options.prefix ?? DEFAULT_HMAC_PREFIX;
  const trimmed = header.trim();
  if (prefix) {
    if (!trimmed.toLowerCase().startsWith(prefix.toLowerCase())) {
      return { ok: false, provider: 'hmac', reason: `header must start with ${prefix}` };
    }
  }
  const presented = prefix ? trimmed.slice(prefix.length).trim() : trimmed;
  const expected = createHmac('sha256', options.secret).update(captureBody(capture)).digest('hex');
  if (!safeEqualHex(expected, presented)) {
    return { ok: false, provider: 'hmac', reason: 'signature mismatch' };
  }
  return { ok: true, provider: 'hmac', reason: 'signature valid' };
}

export function stripeDigest(secret: string, timestamp: number, capture: Capture): string {
  const prefix = Buffer.from(`${timestamp}.`, 'utf8');
  const signed = Buffer.concat([prefix, captureBody(capture)]);
  return createHmac('sha256', secret).update(signed).digest('hex');
}

function parseStripeSignature(header: string): { timestamp: number; v1: string[] } | null {
  let timestamp: number | null = null;
  const v1: string[] = [];
  for (const part of header.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) return null;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key === 't') {
      if (!/^\d+$/.test(value)) return null;
      timestamp = Number(value);
    } else if (key === 'v1') {
      if (!/^[0-9a-fA-F]+$/.test(value) || value.length % 2 !== 0) return null;
      v1.push(value.toLowerCase());
    }
  }
  if (timestamp === null || v1.length === 0) return null;
  return { timestamp, v1 };
}

function safeEqualHex(expectedHex: string, presentedHex: string): boolean {
  const a = expectedHex.trim().toLowerCase();
  const b = presentedHex.trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(a) || !/^[0-9a-f]+$/.test(b)) return false;
  if (a.length !== b.length || a.length % 2 !== 0) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}
