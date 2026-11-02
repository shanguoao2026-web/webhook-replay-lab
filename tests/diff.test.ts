import { describe, expect, test } from 'vitest';
import { diffPayloads } from '../src/diff.js';

describe('payload diff', () => {
  test('treats JSON objects as equal when only whitespace and key order differ', () => {
    const result = diffPayloads('{"b":1,"a":{"z":true}}', '{\n  "a": { "z": true },\n  "b": 1\n}');
    expect(result).toEqual({ equal: true, format: 'json', entries: [] });
  });

  test('reports changed, added, and removed JSON paths', () => {
    const left = '{"order":"o_100","status":"created","amount":2000,"items":[{"sku":"widget","qty":1}]}';
    const right = '{"order":"o_100","status":"paid","amount":2500,"items":[{"sku":"widget","qty":2}],"note":"priority"}';
    const result = diffPayloads(left, right);
    expect(result.equal).toBe(false);
    expect(result.format).toBe('json');
    expect(result.entries).toEqual([
      { path: '$.amount', kind: 'changed', left: 2000, right: 2500 },
      { path: '$.items[0].qty', kind: 'changed', left: 1, right: 2 },
      { path: '$.note', kind: 'added', right: 'priority' },
      { path: '$.status', kind: 'changed', left: 'created', right: 'paid' },
    ]);
  });

  test('distinguishes a missing key from an explicit null and reports array length changes', () => {
    const removed = diffPayloads('{"note":null,"tags":["a","b"]}', '{"tags":["a"]}');
    expect(removed.entries).toEqual([
      { path: '$.note', kind: 'removed', left: null },
      { path: '$.tags[1]', kind: 'removed', left: 'b' },
    ]);
  });

  test('diffs non-JSON bodies by line and flags a JSON/text mismatch', () => {
    const lines = diffPayloads('shipment delayed\nwarehouse A\n', 'shipment delayed\nwarehouse B\n');
    expect(lines.format).toBe('text');
    expect(lines.entries).toEqual([
      { path: 'line 2', kind: 'changed', left: 'warehouse A', right: 'warehouse B' },
    ]);
    expect(diffPayloads('same\n', 'same\n').equal).toBe(true);

    const mixed = diffPayloads('{"a":1}', 'not json');
    expect(mixed.format).toBe('text');
    expect(mixed.entries).toEqual([{ path: '$', kind: 'changed', left: '{"a":1}', right: 'not json' }]);
  });
});
