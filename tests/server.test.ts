import { createHmac } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { verifyHmac } from '../src/verify.js';
import { listCaptures } from '../src/store.js';
import { startServer } from '../src/server.js';
import { cleanup, FIXTURE_SECRET, listen, readIncoming, tempDir } from './helpers.js';

async function boot(dir: string, ui = false, maxBodyBytes = 1024 * 1024) {
  return startServer({ port: 0, host: '127.0.0.1', dir, ui, maxBodyBytes });
}

describe('capture server', () => {
  test('stores a POST with headers, query, and remote address', async () => {
    const dir = await tempDir();
    const server = await boot(dir);
    try {
      const response = await fetch(`${server.url}/hooks/stripe?source=lab`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-request-id': 'req_1',
        },
        body: '{"a": 1}\n',
      });
      const json = (await response.json()) as { ok: boolean; id: string };
      expect(response.status).toBe(200);
      expect(json.ok).toBe(true);
      expect(response.headers.get('x-webhook-replay-id')).toBe(json.id);

      const [capture] = await listCaptures(dir);
      expect(capture?.id).toBe(json.id);
      expect(capture?.method).toBe('POST');
      expect(capture?.path).toBe('/hooks/stripe');
      expect(capture?.query).toBe('source=lab');
      expect(capture?.rawBody).toBe('{"a": 1}\n');
      expect(capture?.contentType).toBe('application/json');
      expect(capture?.headers['x-request-id']).toBe('req_1');
      expect(capture?.remoteAddr).toBeTruthy();
      expect(capture?.bodyEncoding).toBeUndefined();
    } finally {
      await server.close();
      await cleanup(dir);
    }
  });

  test('keeps binary bodies lossless for HMAC verification and replay', async () => {
    const dir = await tempDir();
    const server = await boot(dir);
    const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x61]);
    const digest = createHmac('sha256', FIXTURE_SECRET).update(bytes).digest('hex');
    const target = await listen(async (req, res) => {
      const incoming = await readIncoming(req);
      expect(Buffer.compare(incoming.body, bytes)).toBe(0);
      res.end('ok');
    });
    try {
      const response = await fetch(`${server.url}/hooks/bin`, {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'x-hub-signature-256': `sha256=${digest}`,
        },
        body: bytes,
      });
      const { id } = (await response.json()) as { id: string };
      const [capture] = await listCaptures(dir);
      expect(capture?.bodyEncoding).toBe('base64');
      expect(verifyHmac(capture!, { secret: FIXTURE_SECRET }).ok).toBe(true);

      const replay = await fetch(`${server.url}/api/captures/${id}/replay`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ to: `${target.url}/bin` }),
      });
      const result = (await replay.json()) as { ok: boolean; status: number };
      expect(result.ok).toBe(true);
      expect(result.status).toBe(200);
    } finally {
      await server.close();
      await target.close();
      await cleanup(dir);
    }
  });

  test('serves health, ignores favicon, and does not record the API or the index', async () => {
    const dir = await tempDir();
    const server = await boot(dir, false);
    try {
      const health = await fetch(`${server.url}/health`);
      expect(await health.json()).toMatchObject({ ok: true, service: 'webhook-replay-lab', version: '0.1.0' });
      expect((await fetch(`${server.url}/favicon.ico`)).status).toBe(204);
      const index = await fetch(`${server.url}/`);
      expect(await index.text()).toContain('ui: disabled');
      expect((await index.headers.get('content-type')) ?? '').toContain('text/plain');
      const missing = await fetch(`${server.url}/api/captures/nope`);
      expect(missing.status).toBe(404);
      expect(await listCaptures(dir)).toEqual([]);
    } finally {
      await server.close();
      await cleanup(dir);
    }
  });

  test('serves the UI and the JSON API used by the page', async () => {
    const dir = await tempDir();
    const server = await boot(dir, true);
    const target = await listen(async (req, res) => {
      const incoming = await readIncoming(req);
      expect(incoming.body.toString('utf8')).toBe('{"hello":"ui"}');
      expect(incoming.headers['stripe-signature']).toBe('t=1,v1=abcd');
      res.end('replayed');
    });
    try {
      const page = await fetch(`${server.url}/`);
      const html = await page.text();
      expect(page.headers.get('content-type')).toContain('text/html');
      expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");
      expect(html).toContain('id="replay-form"');
      expect(html).toContain('id="copy-curl"');
      expect(html).not.toContain('{"hello":"ui"}');

      const posted = await fetch(`${server.url}/hooks/app`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'stripe-signature': 't=1,v1=abcd',
        },
        body: '{"hello":"ui"}',
      });
      const { id } = (await posted.json()) as { id: string };

      const list = (await (await fetch(`${server.url}/api/captures`)).json()) as {
        captures: Array<{ id: string; bytes: number }>;
      };
      expect(list.captures.map((item) => item.id)).toEqual([id]);
      expect(list.captures[0]?.bytes).toBe(Buffer.byteLength('{"hello":"ui"}'));

      const detail = (await (await fetch(`${server.url}/api/captures/${id}`)).json()) as {
        capture: { rawBody: string };
      };
      expect(detail.capture.rawBody).toBe('{"hello":"ui"}');

      const curl = (await (await fetch(`${server.url}/api/captures/${id}/curl`)).json()) as { curl: string };
      expect(curl.curl).toContain(server.url);
      expect(curl.curl).not.toContain('content-length');

      const targeted = (await (
        await fetch(`${server.url}/api/captures/${id}/curl?to=${encodeURIComponent(`${target.url}/in`)}`)
      ).json()) as { curl: string };
      expect(targeted.curl).toContain(`${target.url}/in`);

      const rejected = await fetch(`${server.url}/api/captures/${id}/curl?to=${encodeURIComponent('file:///tmp/x')}`);
      expect(rejected.status).toBe(400);

      const replay = await fetch(`${server.url}/api/captures/${id}/replay`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ to: `${target.url}/in`, preserveHeaders: true }),
      });
      const result = (await replay.json()) as { ok: boolean; body: string; status: number };
      expect(result).toMatchObject({ ok: true, status: 200, body: 'replayed' });

      const badReplay = await fetch(`${server.url}/api/captures/${id}/replay`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{',
      });
      expect(badReplay.status).toBe(400);

      const after = await listCaptures(dir);
      expect(after).toHaveLength(1);
    } finally {
      await server.close();
      await target.close();
      await cleanup(dir);
    }
  });

  test('rejects an oversized body without writing a capture', async () => {
    const dir = await tempDir();
    const server = await boot(dir, false, 32);
    try {
      const response = await fetch(`${server.url}/hooks/big`, {
        method: 'POST',
        body: 'x'.repeat(64),
      });
      expect(response.status).toBe(413);
      expect(await listCaptures(dir)).toEqual([]);
    } finally {
      await server.close();
      await cleanup(dir);
    }
  });
});
