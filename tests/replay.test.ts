import http from 'node:http';
import { describe, expect, test } from 'vitest';
import { replayCapture } from '../src/replay.js';
import { listen, readIncoming, sampleCapture } from './helpers.js';

describe('replay', () => {
  test('posts the raw body and a safe header set', async () => {
    let seen: { body: string; headers: http.IncomingHttpHeaders; method?: string } | undefined;
    const server = await listen(async (req, res) => {
      const incoming = await readIncoming(req);
      seen = { body: incoming.body.toString('utf8'), headers: incoming.headers, method: req.method };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"received":true}');
    });
    try {
      const capture = sampleCapture({
        id: 'whr_replay',
        rawBody: '{"a":1}',
        headers: {
          'content-type': 'application/json',
          'stripe-signature': 't=1,v1=abcd',
          host: 'evil.example',
          'content-length': '99999',
          'user-agent': 'Stripe/1.0',
        },
      });
      const result = await replayCapture(capture, { to: `${server.url}/hook` });
      expect(result.ok).toBe(true);
      expect(result.status).toBe(200);
      expect(result.body).toBe('{"received":true}');
      expect(seen?.method).toBe('POST');
      expect(seen?.body).toBe('{"a":1}');
      expect(seen?.headers['content-type']).toBe('application/json');
      expect(seen?.headers['stripe-signature']).toBeUndefined();
      expect(seen?.headers['x-webhook-replay-id']).toBe('whr_replay');
      expect(seen?.headers['user-agent']).toBe('webhook-replay-lab');
      expect(seen?.headers['content-length']).toBe('7');
      expect(seen?.headers.host).toBe(`127.0.0.1:${server.port}`);
    } finally {
      await server.close();
    }
  });

  test('preserves original headers when asked, except hop-by-hop fields', async () => {
    let headers: http.IncomingHttpHeaders | undefined;
    const server = await listen(async (req, res) => {
      await readIncoming(req);
      headers = req.headers;
      res.writeHead(204);
      res.end();
    });
    try {
      const capture = sampleCapture({
        method: 'PUT',
        rawBody: '{"a":1}',
        headers: {
          'content-type': 'application/json',
          'stripe-signature': 't=1,v1=abcd',
          host: 'evil.example',
          'content-length': '99999',
          'user-agent': 'Stripe/1.0',
          'x-note': 'ok\r\nX-Injected: yes',
        },
      });
      const result = await replayCapture(capture, { to: `${server.url}/hook`, preserveHeaders: true });
      expect(result.ok).toBe(true);
      expect(headers?.['stripe-signature']).toBe('t=1,v1=abcd');
      expect(headers?.['user-agent']).toBe('Stripe/1.0');
      expect(headers?.['x-note']).toBeUndefined();
      expect(headers?.['x-injected']).toBeUndefined();
      expect(headers?.['x-webhook-replay-id']).toBeUndefined();
      expect(headers?.['content-length']).toBe('7');
      expect(headers?.host).toBe(`127.0.0.1:${server.port}`);
    } finally {
      await server.close();
    }
  });

  test('reports non-2xx responses, refused connections, bad URLs, and timeouts', async () => {
    const server = await listen((_req, res) => {
      res.writeHead(500);
      res.end('nope');
    });
    try {
      const failed = await replayCapture(sampleCapture(), { to: `${server.url}/hook` });
      expect(failed.ok).toBe(false);
      expect(failed.status).toBe(500);
      expect(failed.body).toBe('nope');
    } finally {
      await server.close();
    }

    const refused = await replayCapture(sampleCapture(), { to: 'http://127.0.0.1:1/hook', timeoutMs: 1000 });
    expect(refused.ok).toBe(false);
    expect(refused.status).toBeNull();
    expect(refused.error).toBeTruthy();

    const bad = await replayCapture(sampleCapture(), { to: 'not a url' });
    expect(bad.error).toMatch(/Invalid target URL/);
    const fileUrl = await replayCapture(sampleCapture(), { to: 'file:///tmp/hook' });
    expect(fileUrl.error).toMatch(/Unsupported protocol/);

    const hanging = http.createServer(() => undefined);
    await new Promise<void>((resolve) => hanging.listen(0, '127.0.0.1', () => resolve()));
    const address = hanging.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    try {
      const timed = await replayCapture(sampleCapture(), {
        to: `http://127.0.0.1:${port}/slow`,
        timeoutMs: 200,
      });
      expect(timed.ok).toBe(false);
      expect(timed.error).toMatch(/timed out/);
    } finally {
      hanging.closeAllConnections?.();
      await new Promise<void>((resolve, reject) => hanging.close((err) => (err ? reject(err) : resolve())));
    }
  });

  test('does not follow redirects', async () => {
    let followed = false;
    const next = await listen((_req, res) => {
      followed = true;
      res.end('followed');
    });
    const first = await listen((_req, res) => {
      res.writeHead(302, { location: `${next.url}/landed` });
      res.end();
    });
    try {
      const result = await replayCapture(sampleCapture(), { to: `${first.url}/hook` });
      expect(followed).toBe(false);
      expect(result.ok).toBe(false);
      expect(result.status).not.toBe(200);
    } finally {
      await first.close();
      await next.close();
    }
  });
});
