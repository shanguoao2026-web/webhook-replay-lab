import type { Capture } from './types.js';

export function encodeBody(buf: Buffer): { rawBody: string; bodyEncoding?: 'base64' } {
  const asUtf8 = buf.toString('utf8');
  if (Buffer.compare(Buffer.from(asUtf8, 'utf8'), buf) === 0) {
    return { rawBody: asUtf8 };
  }
  return { rawBody: buf.toString('base64'), bodyEncoding: 'base64' };
}

/** Bytes that were signed or that should be replayed. */
export function captureBody(capture: Pick<Capture, 'rawBody' | 'bodyEncoding'>): Buffer {
  if (capture.bodyEncoding === 'base64') {
    return Buffer.from(capture.rawBody, 'base64');
  }
  return Buffer.from(capture.rawBody, 'utf8');
}
