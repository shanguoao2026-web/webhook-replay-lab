import { describe, expect, test } from 'vitest';
import { toCurl } from '../src/curl.js';
import { renderUiPage } from '../src/ui.js';
import { sampleCapture } from './helpers.js';

describe('curl and ui page', () => {
  test('builds a quoted curl command and skips hop-by-hop headers', () => {
    const curl = toCurl(
      sampleCapture({
        rawBody: `{"note":"it's ready"}`,
        headers: {
          'content-type': 'application/json',
          host: 'example.test',
          'content-length': '20',
          'x-request-id': 'abc',
        },
      }),
      'http://127.0.0.1:9999/hook',
    );
    expect(curl).toContain("curl -sS -X POST");
    expect(curl).toContain("'http://127.0.0.1:9999/hook'");
    expect(curl).toContain(`--data-binary '{"note":"it'\\''s ready"}'`);
    expect(curl).toContain("-H 'x-request-id: abc'");
    expect(curl).not.toContain('example.test');
    expect(curl).not.toContain('content-length');
  });

  test('serves a static page whose script parses and does not inject captures', () => {
    const html = renderUiPage();
    expect(html).toContain('webhook-replay-lab');
    expect(html).toContain('Copy curl');
    expect(html).toContain('Preserve headers');
    expect(html).toContain('/api/captures');
    expect(html).not.toContain('innerHTML');
    const script = html.match(/<script>([\s\S]*)<\/script>/);
    expect(script?.[1]).toBeTruthy();
    expect(() => new Function(script?.[1] ?? '')).not.toThrow();
  });
});
