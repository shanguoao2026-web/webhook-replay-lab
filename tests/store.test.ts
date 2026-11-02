import { access, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { listCaptures, readCapture, saveCapture } from '../src/store.js';
import { cleanup, sampleCapture, tempDir } from './helpers.js';

describe('capture store', () => {
  test('round-trips a capture as pretty JSON on disk', async () => {
    const dir = await tempDir();
    try {
      const capture = sampleCapture({
        id: 'whr_round',
        headers: { 'content-type': 'application/json', 'x-request-id': ['a', 'b'] },
        rawBody: '{"café":"naïve"}',
        query: 'x=1',
      });
      const file = await saveCapture(dir, capture);
      expect(file.endsWith(`${path.sep}whr_round.json`)).toBe(true);
      const text = await readFile(file, 'utf8');
      expect(text.endsWith('\n')).toBe(true);
      expect(await readCapture(dir, 'whr_round')).toEqual(capture);
      const names = await readdir(dir);
      expect(names.filter((name) => name.includes('.tmp') || name.startsWith('.'))).toEqual([]);
    } finally {
      await cleanup(dir);
    }
  });

  test('lists newest captures first and treats a missing directory as empty', async () => {
    const dir = await tempDir();
    try {
      await saveCapture(dir, sampleCapture({ id: 'whr_old', timestamp: '2024-01-01T00:00:00.000Z' }));
      await saveCapture(dir, sampleCapture({ id: 'whr_new', timestamp: '2024-06-01T00:00:00.000Z' }));
      await saveCapture(dir, sampleCapture({ id: 'whr_mid', timestamp: '2024-03-01T00:00:00.000Z' }));
      const listed = await listCaptures(dir);
      expect(listed.map((item) => item.id)).toEqual(['whr_new', 'whr_mid', 'whr_old']);
      expect(await listCaptures(path.join(dir, 'missing'))).toEqual([]);
    } finally {
      await cleanup(dir);
    }
  });

  test('rejects a missing id, a corrupt file, an id mismatch, and an unsafe id', async () => {
    const dir = await tempDir();
    try {
      await expect(readCapture(dir, 'whr_missing')).rejects.toThrow('Capture not found: whr_missing');
      await writeFile(path.join(dir, 'whr_bad.json'), '{', 'utf8');
      await expect(listCaptures(dir)).rejects.toThrow('Invalid capture file: whr_bad.json');
      await writeFile(
        path.join(dir, 'whr_bad.json'),
        JSON.stringify({ ...sampleCapture({ id: 'whr_other' }) }, null, 2),
        'utf8',
      );
      await expect(readCapture(dir, 'whr_bad')).rejects.toThrow('Capture id mismatch');
      const outside = path.join(dir, 'escaped.json');
      await expect(saveCapture(dir, sampleCapture({ id: '../escaped' }))).rejects.toThrow('Invalid capture id.');
      await expect(readCapture(dir, '../escaped')).rejects.toThrow('Invalid capture id.');
      expect(await readdir(path.dirname(dir))).not.toContain('escaped.json');
      await expect(access(outside)).rejects.toThrow();
    } finally {
      await cleanup(dir);
    }
  });
});
