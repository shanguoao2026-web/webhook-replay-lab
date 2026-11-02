export interface Capture {
  id: string;
  /** ISO-8601 time the event was recorded. */
  timestamp: string;
  method: string;
  path: string;
  /** Query string without the leading `?`. Empty when the request had none. */
  query: string;
  headers: Record<string, string | string[]>;
  /**
   * Exact request body. UTF-8 text, or base64 when `bodyEncoding` is `base64`
   * (bytes that are not valid UTF-8).
   */
  rawBody: string;
  /** Present and set to `base64` only when `rawBody` is not UTF-8 text. */
  bodyEncoding?: 'utf8' | 'base64';
  contentType: string | null;
  remoteAddr: string | null;
}

export interface CaptureSummary {
  id: string;
  timestamp: string;
  method: string;
  path: string;
  query: string;
  contentType: string | null;
  remoteAddr: string | null;
  bytes: number;
}

export interface ReplayResult {
  ok: boolean;
  id: string;
  target: string;
  status: number | null;
  headers: Record<string, string>;
  body: string;
  error?: string;
}

export interface VerifyResult {
  ok: boolean;
  provider: 'stripe' | 'hmac';
  reason: string;
  /** Unix seconds from the Stripe-Signature header, when one was parsed. */
  timestamp?: number;
}

export type DiffKind = 'added' | 'removed' | 'changed';

export interface DiffEntry {
  path: string;
  kind: DiffKind;
  left?: unknown;
  right?: unknown;
}

export interface DiffResult {
  equal: boolean;
  format: 'json' | 'text';
  entries: DiffEntry[];
}
