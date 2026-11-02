import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { listCaptures } from '../src/store.js';
import { VERSION } from '../src/constants.js';
import {
  cleanup,
  cliPath,
  FIXTURE_SECRET,
  fixturesDir,
  listen,
  readIncoming,
  root,
  runCli,
  spawnCli,
  stopChild,
  tempDir,
  waitForText,
} from './helpers.js';

const quietEnv = {
  STRIPE_WEBHOOK_SECRET: undefined,
  WEBHOOK_SECRET: undefined,
};

describe('CLI', () => {
  test('prints help and the package version', async () => {
    const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as { version: string };
    expect(pkg.version).toBe(VERSION);
    const bin = await readFile(cliPath, 'utf8');
    expect(bin.startsWith('#!/usr/bin/env node\n')).toBe(true);

    const help = await runCli(['--help'], quietEnv);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('webhook-replay-lab');
    expect(help.stdout).toContain('serve');
    expect(help.stdout).toContain('verify');
    expect(help.stdout).toContain('STRIPE_WEBHOOK_SECRET');

    const version = await runCli(['--version'], quietEnv);
    expect(version.code).toBe(0);
    expect(version.stdout.trim()).toBe(pkg.version);

    const bare = await runCli([], quietEnv);
    expect(bare.code).toBe(1);
    expect(bare.stdout).toContain('serve');

    const unknown = await runCli(['frobnicate'], quietEnv);
    expect(unknown.code).not.toBe(0);
  });

  test('lists and shows fixture captures', async () => {
    const listed = await runCli(['list', '--dir', fixturesDir], quietEnv);
    expect(listed.code).toBe(0);
    const lines = listed.stdout.trim().split('\n');
    expect(lines[0]).toContain('ID');
    expect(lines[1]).toContain('fix_telegram');
    expect(listed.stdout).toContain('fix_stripe_valid');
    expect(listed.stdout.indexOf('fix_order_b')).toBeLessThan(listed.stdout.indexOf('fix_order_a'));

    const asJson = await runCli(['list', '--dir', fixturesDir, '--json'], quietEnv);
    const parsed = JSON.parse(asJson.stdout) as Array<{ id: string }>;
    expect(parsed[0]?.id).toBe('fix_telegram');

    const shown = await runCli(['show', 'fix_stripe_valid', '--dir', fixturesDir], quietEnv);
    expect(shown.code).toBe(0);
    expect(JSON.parse(shown.stdout).id).toBe('fix_stripe_valid');

    const missing = await runCli(['show', 'missing', '--dir', fixturesDir], quietEnv);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('Capture not found: missing');

    const unsafe = await runCli(['show', '../package', '--dir', fixturesDir], quietEnv);
    expect(unsafe.code).toBe(1);
    expect(unsafe.stderr).toContain('Invalid capture id.');
  });

  test('diffs two fixture orders', async () => {
    const result = await runCli(['diff', 'fix_order_a', 'fix_order_b', '--dir', fixturesDir], quietEnv);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('equal: false');
    expect(result.stdout).toContain('$.status');
    expect(result.stdout).toContain('paid');
    expect(result.stdout).toContain('$.note');

    const json = await runCli(['diff', 'fix_order_a', 'fix_order_b', '--dir', fixturesDir, '--json'], quietEnv);
    const parsed = JSON.parse(json.stdout) as { equal: boolean; entries: unknown[] };
    expect(parsed.equal).toBe(false);
    expect(parsed.entries.length).toBeGreaterThan(0);

    const same = await runCli(['diff', 'fix_order_a', 'fix_order_a', '--dir', fixturesDir], quietEnv);
    expect(same.stdout).toContain('equal: true');
  });

  test('verifies stripe and hmac fixtures without printing the secret', async () => {
    const stripe = await runCli(
      ['verify', 'fix_stripe_valid', '--provider', 'stripe', '--secret', FIXTURE_SECRET, '--now', '1700000100', '--dir', fixturesDir],
      quietEnv,
    );
    expect(stripe.code).toBe(0);
    expect(stripe.stdout).toContain('valid');
    expect(stripe.stdout + stripe.stderr).not.toContain(FIXTURE_SECRET);

    const invalid = await runCli(
      ['verify', 'fix_stripe_invalid', '--provider', 'stripe', '--secret', FIXTURE_SECRET, '--now', '1700000100', '--dir', fixturesDir, '--json'],
      quietEnv,
    );
    expect(invalid.code).toBe(1);
    expect(JSON.parse(invalid.stdout).reason).toBe('signature mismatch');
    expect(invalid.stdout + invalid.stderr).not.toContain(FIXTURE_SECRET);

    const stale = await runCli(
      ['verify', 'fix_stripe_stale', '--provider', 'stripe', '--secret', FIXTURE_SECRET, '--now', '1700000000', '--dir', fixturesDir],
      quietEnv,
    );
    expect(stale.code).toBe(1);
    expect(stale.stdout).toContain('outside tolerance');

    const hmac = await runCli(['verify', 'fix_hmac_valid', '--provider', 'hmac', '--dir', fixturesDir], {
      WEBHOOK_SECRET: FIXTURE_SECRET,
      STRIPE_WEBHOOK_SECRET: undefined,
    });
    expect(hmac.code).toBe(0);
    expect(hmac.stdout).toContain('provider=hmac');
    expect(hmac.stdout + hmac.stderr).not.toContain(FIXTURE_SECRET);

    const missingSecret = await runCli(['verify', 'fix_hmac_valid', '--provider', 'hmac', '--dir', fixturesDir], quietEnv);
    expect(missingSecret.code).toBe(1);
    expect(missingSecret.stderr).toContain('Missing secret');

    const secretDir = await tempDir();
    try {
      const secretFile = path.join(secretDir, 'secret.txt');
      await writeFile(secretFile, `\n${FIXTURE_SECRET}\n`, 'utf8');
      const fromFile = await runCli(
        ['verify', 'fix_stripe_rotation', '--provider', 'stripe', '--secret-file', secretFile, '--now', '1700000000', '--dir', fixturesDir],
        quietEnv,
      );
      expect(fromFile.code).toBe(0);
      expect(fromFile.stdout).toContain('signature valid');
    } finally {
      await cleanup(secretDir);
    }
  });

  test('replays a fixture to a local mock target', async () => {
    let seenBody = '';
    let seenSignature: string | undefined;
    const server = await listen(async (req, res) => {
      const incoming = await readIncoming(req);
      seenBody = incoming.body.toString('utf8');
      seenSignature = incoming.headers['stripe-signature'] as string | undefined;
      res.writeHead(201, { 'content-type': 'text/plain' });
      res.end('stored');
    });
    try {
      const plain = await runCli(
        ['replay', 'fix_order_a', '--to', `${server.url}/hook`, '--dir', fixturesDir],
        quietEnv,
      );
      expect(plain.code).toBe(0);
      expect(plain.stdout).toContain('status: 201');
      expect(seenBody).toContain('"status":"created"');
      expect(seenSignature).toBeUndefined();

      const preserved = await runCli(
        ['replay', 'fix_stripe_valid', '--to', `${server.url}/hook`, '--dir', fixturesDir, '--preserve-headers', '--json'],
        quietEnv,
      );
      expect(preserved.code).toBe(0);
      expect(JSON.parse(preserved.stdout).status).toBe(201);
      expect(seenSignature).toContain('t=1700000000');
    } finally {
      await server.close();
    }
  });

  test('serve records a webhook and exposes health', async () => {
    const dir = await tempDir();
    const child = spawnCli(['serve', '--port', '0', '--dir', dir, '--ui']);
    try {
      const banner = await waitForText(child.stdout, /listening on (http:\/\/\S+)/);
      const url = banner.match(/listening on (http:\/\/\S+)/)?.[1];
      expect(url).toBeTruthy();
      expect(banner).toContain('ui:');

      const health = await fetch(`${url}/health`);
      expect((await health.json() as { ok: boolean }).ok).toBe(true);

      const page = await fetch(`${url}/`);
      expect(await page.text()).toContain('webhook-replay-lab');

      const posted = await fetch(`${url}/hooks/stripe`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"from":"cli"}',
      });
      expect((await posted.json() as { ok: boolean }).ok).toBe(true);
      await stopChild(child);

      const captures = await listCaptures(dir);
      expect(captures).toHaveLength(1);
      expect(captures[0]?.rawBody).toBe('{"from":"cli"}');
      expect(captures[0]?.path).toBe('/hooks/stripe');
    } finally {
      await stopChild(child);
      await cleanup(dir);
    }
  });
});
