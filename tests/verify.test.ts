import { createHmac } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { readCapture } from '../src/store.js';
import { verifyHmac, verifyStripe } from '../src/verify.js';
import { FIXTURE_SECRET, fixturesDir, sampleCapture } from './helpers.js';

const NOW = 1_700_000_000;
const BODY = '{"id":"evt_1","type":"charge.succeeded"}';

function stripeHeader(secret: string, timestamp: number, body: string, extra = ''): string {
  const v1 = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${v1}${extra}`;
}

describe('signature verification', () => {
  test('accepts a Stripe signature inside the tolerance window', () => {
    const capture = sampleCapture({
      rawBody: BODY,
      headers: { 'Stripe-Signature': stripeHeader(FIXTURE_SECRET, NOW, BODY).toUpperCase().replace('T=', 't=').replace('V1=', 'v1=') },
    });
    // Header hex is produced in lowercase by the helper; mixed-case header name is the point.
    const result = verifyStripe(capture, { secret: FIXTURE_SECRET, nowSec: NOW + 300, toleranceSec: 300 });
    expect(result).toMatchObject({ ok: true, provider: 'stripe', reason: 'signature valid', timestamp: NOW });
  });

  test('rejects a bad Stripe signature, a missing header, a malformed header, and an empty secret', () => {
    const bad = sampleCapture({
      rawBody: BODY,
      headers: { 'stripe-signature': stripeHeader(FIXTURE_SECRET, NOW, BODY).replace(/.$/, '0') },
    });
    const mismatch = verifyStripe(bad, { secret: FIXTURE_SECRET, nowSec: NOW });
    expect(mismatch.ok).toBe(false);
    expect(mismatch.reason).toBe('signature mismatch');
    expect(JSON.stringify(mismatch)).not.toContain(FIXTURE_SECRET);

    const missing = verifyStripe(sampleCapture({ headers: {} }), { secret: FIXTURE_SECRET, nowSec: NOW });
    expect(missing.reason).toMatch(/missing stripe-signature/i);

    const malformed = verifyStripe(sampleCapture({ headers: { 'stripe-signature': 'nope' } }), {
      secret: FIXTURE_SECRET,
      nowSec: NOW,
    });
    expect(malformed.reason).toMatch(/malformed/);

    expect(verifyStripe(sampleCapture(), { secret: '' }).ok).toBe(false);
  });

  test('enforces the Stripe age window and ignores v0 signatures', () => {
    const header = stripeHeader(FIXTURE_SECRET, NOW, BODY);
    const capture = sampleCapture({ rawBody: BODY, headers: { 'stripe-signature': header } });
    expect(verifyStripe(capture, { secret: FIXTURE_SECRET, nowSec: NOW + 300, toleranceSec: 300 }).ok).toBe(true);
    const stale = verifyStripe(capture, { secret: FIXTURE_SECRET, nowSec: NOW + 301, toleranceSec: 300 });
    expect(stale.ok).toBe(false);
    expect(stale.reason).toMatch(/outside tolerance/);

    expect(verifyStripe(capture, { secret: FIXTURE_SECRET, nowSec: NOW - 50, toleranceSec: 300 }).ok).toBe(true);
    expect(verifyStripe(capture, { secret: FIXTURE_SECRET, nowSec: NOW + 10_000, toleranceSec: 0 }).ok).toBe(true);

    const v0 = createHmac('sha256', FIXTURE_SECRET).update(`${NOW}.${BODY}`).digest('hex');
    const onlyV0 = sampleCapture({
      rawBody: BODY,
      headers: { 'stripe-signature': `t=${NOW},v0=${v0},v1=${'ab'.repeat(32)}` },
    });
    expect(verifyStripe(onlyV0, { secret: FIXTURE_SECRET, nowSec: NOW }).ok).toBe(false);
  });

  test('accepts any v1 signature so a rotated Stripe secret still verifies', () => {
    const current = createHmac('sha256', FIXTURE_SECRET).update(`${NOW}.${BODY}`).digest('hex');
    const previous = createHmac('sha256', 'whsec_old_fixture_only').update(`${NOW}.${BODY}`).digest('hex');
    const capture = sampleCapture({
      rawBody: BODY,
      headers: { 'stripe-signature': `t=${NOW},v1=${previous},v1=${current}` },
    });
    expect(verifyStripe(capture, { secret: FIXTURE_SECRET, nowSec: NOW }).ok).toBe(true);
    expect(verifyStripe(capture, { secret: 'whsec_old_fixture_only', nowSec: NOW }).ok).toBe(true);
    expect(verifyStripe(capture, { secret: 'whsec_unknown', nowSec: NOW }).ok).toBe(false);
  });

  test('rejects a Stripe signature computed over a re-serialized body', () => {
    const signed = '{"a":1}';
    const pretty = '{\n  "a": 1\n}';
    const capture = sampleCapture({
      rawBody: pretty,
      headers: { 'stripe-signature': stripeHeader(FIXTURE_SECRET, NOW, signed) },
    });
    expect(verifyStripe(capture, { secret: FIXTURE_SECRET, nowSec: NOW }).ok).toBe(false);
  });

  test('verifies a shared-secret HMAC and rejects prefix, header, and digest mistakes', () => {
    const digest = createHmac('sha256', FIXTURE_SECRET).update(BODY).digest('hex');
    const good = sampleCapture({
      rawBody: BODY,
      headers: { 'X-Hub-Signature-256': `sha256=${digest}` },
    });
    expect(verifyHmac(good, { secret: FIXTURE_SECRET })).toMatchObject({ ok: true, provider: 'hmac' });

    const upper = sampleCapture({ rawBody: BODY, headers: { 'x-hub-signature-256': `SHA256=${digest.toUpperCase()}` } });
    expect(verifyHmac(upper, { secret: FIXTURE_SECRET }).ok).toBe(true);

    const wrong = sampleCapture({ rawBody: BODY, headers: { 'x-hub-signature-256': `sha256=${'00'.repeat(32)}` } });
    const mismatch = verifyHmac(wrong, { secret: FIXTURE_SECRET });
    expect(mismatch.ok).toBe(false);
    expect(JSON.stringify(mismatch)).not.toContain(FIXTURE_SECRET);

    expect(verifyHmac(sampleCapture({ rawBody: BODY, headers: {} }), { secret: FIXTURE_SECRET }).reason).toMatch(/missing/);
    expect(
      verifyHmac(sampleCapture({ rawBody: BODY, headers: { 'x-hub-signature-256': digest } }), { secret: FIXTURE_SECRET })
        .reason,
    ).toMatch(/sha256=/);
    expect(verifyHmac(good, { secret: '' }).ok).toBe(false);

    const custom = sampleCapture({ rawBody: BODY, headers: { 'x-signature': digest } });
    expect(verifyHmac(custom, { secret: FIXTURE_SECRET, headerName: 'x-signature', prefix: '' }).ok).toBe(true);
  });

  test('verifies the checked-in fixtures offline', async () => {
    const stripe = await readCapture(fixturesDir, 'fix_stripe_valid');
    expect(verifyStripe(stripe, { secret: FIXTURE_SECRET, nowSec: NOW + 100 }).ok).toBe(true);

    const invalid = await readCapture(fixturesDir, 'fix_stripe_invalid');
    expect(verifyStripe(invalid, { secret: FIXTURE_SECRET, nowSec: NOW + 100 }).ok).toBe(false);

    const stale = await readCapture(fixturesDir, 'fix_stripe_stale');
    expect(verifyStripe(stale, { secret: FIXTURE_SECRET, nowSec: NOW }).reason).toMatch(/outside tolerance/);

    const rotation = await readCapture(fixturesDir, 'fix_stripe_rotation');
    expect(verifyStripe(rotation, { secret: FIXTURE_SECRET, nowSec: NOW }).ok).toBe(true);

    const hmac = await readCapture(fixturesDir, 'fix_hmac_valid');
    expect(verifyHmac(hmac, { secret: FIXTURE_SECRET }).ok).toBe(true);
    const hmacBad = await readCapture(fixturesDir, 'fix_hmac_invalid');
    expect(verifyHmac(hmacBad, { secret: FIXTURE_SECRET }).ok).toBe(false);
  });
});
