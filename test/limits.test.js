// Spending limits: per call, per process (session), and the persisted rolling 24-hour ceiling
// that a restart — or several processes at once — cannot reset.

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { connect, tempDir } from './helpers.js';
import { createFakeBacon } from './fake-bacon.js';

const url = (n) => ({ image_url: `https://example.com/photo-${n}.png` });

test('defaults are 0.50 per call, 1.00 per session and 5.00 per 24 hours', async () => {
    const { call } = await connect();
    const status = await call('wallet_status');
    assert.deepEqual(status.data.limits_usdc, { per_call: '0.5', per_session: '1', per_24_hours: '5' });
});

test('a price above the per-call limit is refused before signing', async () => {
    const { call, fake } = await connect({ env: { BACON_MAX_PER_CALL: '0.19' } });
    const result = await call('remove_background', url(1));
    assert.match(result.data.error, /0\.2 USDC is above your per-call limit of 0\.19 USDC \(BACON_MAX_PER_CALL\)/);
    assert.equal(fake.paymentHeaders.length, 0);
    assert.equal((await call('remove_background', url(1))).error, true);
});

test('the per-session limit stops the purchase that would cross it', async () => {
    const { call, fake } = await connect({ env: { BACON_MAX_PER_SESSION: '0.45' } });
    assert.equal((await call('remove_background', url(1))).error, false);
    assert.equal((await call('remove_background', url(2))).error, false);
    const third = await call('remove_background', url(3));
    assert.match(third.data.error, /this session has used 0\.4 of its 0\.45 USDC limit/);
    assert.equal(fake.settled.length, 2);
    const small = await call('optimize_image', url(4));
    assert.equal(small.error, false, 'a purchase that still fits goes ahead');
});

test('the daily ceiling survives a restart: a new process with the same ledger cannot spend it again', async () => {
    const ledgerDir = tempDir();
    const fake = createFakeBacon();
    const env = { BACON_MAX_PER_DAY: '0.45', BACON_MAX_PER_SESSION: '1.00' };
    let clock = Date.parse('2026-10-17T10:00:00Z');
    const now = () => clock;

    const first = await connect({ fake, ledgerDir, env, now });
    assert.equal((await first.call('remove_background', url(1))).error, false);
    assert.equal((await first.call('remove_background', url(2))).error, false);

    // The host restarts the MCP process: a fresh session budget, the same day.
    const second = await connect({ fake, ledgerDir, env, now });
    const refused = await second.call('remove_background', url(3));
    assert.match(refused.data.error, /the last 24 hours have used 0\.4 of your 0\.45 USDC daily limit \(BACON_MAX_PER_DAY\)/);
    assert.equal(fake.settled.length, 2);
    assert.equal((await second.call('wallet_status')).data.spent_usdc.last_24_hours, '0.4');

    // Rolling 24 hours, not midnight: still refused just before, allowed just after.
    clock += 24 * 3600 * 1000 - 60_000;
    assert.equal((await second.call('remove_background', url(4))).error, true);
    clock += 120_000;
    const third = await connect({ fake, ledgerDir, env, now });
    assert.equal((await third.call('remove_background', url(5))).error, false);
});

test('two processes buying at once cannot both pass the daily ceiling', async () => {
    const ledgerDir = tempDir();
    const fake = createFakeBacon();
    const env = { BACON_MAX_PER_DAY: '0.30' };
    const a = await connect({ fake, ledgerDir, env });
    const b = await connect({ fake, ledgerDir, env });
    const results = await Promise.all([a.call('remove_background', url(1)), b.call('remove_background', url(2))]);
    assert.deepEqual(results.map((r) => r.error).sort(), [false, true]);
    assert.match(results.find((r) => r.error).data.error, /daily limit/);
    assert.equal(fake.settled.length, 1);
});

test('a refused payment gives its amount back to the limits; an uncertain one does not', async () => {
    const fake = createFakeBacon();
    const { call } = await connect({ fake, env: { BACON_MAX_PER_DAY: '0.25' } });
    fake.tweak.verify = 'insufficient_funds';
    await call('remove_background', url(1));
    fake.tweak.verify = undefined;
    assert.equal((await call('remove_background', url(2))).error, false, 'the released 0.2 did not count');

    const other = createFakeBacon();
    other.tweak.executeFailure = [502, 'bad gateway'];
    const second = await connect({ fake: other, env: { BACON_MAX_PER_DAY: '0.25' } });
    await second.call('remove_background', url(1));
    other.tweak.executeFailure = undefined;
    assert.match((await second.call('remove_background', url(2))).data.error, /limit/);
});

test('a damaged ledger refuses every payment instead of starting from zero', async () => {
    const ledgerDir = tempDir();
    writeFileSync(join(ledgerDir, 'spend-ledger.json'), '{not json');
    const { call, fake } = await connect({ ledgerDir });
    const result = await call('optimize_image', url(1));
    assert.match(result.data.error, /spend ledger .* is damaged\. No payment is made/);
    assert.equal(fake.paymentHeaders.length, 0);
});

test('limits that are not amounts, or not above zero, are configuration problems', async () => {
    for (const [name, value] of [['BACON_MAX_PER_CALL', 'lots'], ['BACON_MAX_PER_DAY', '0'], ['BACON_MAX_PER_SESSION', '-1'], ['BACON_MAX_PER_CALL', '0.1234567']]) {
        const { call, fake } = await connect({ env: { [name]: value } });
        const result = await call('optimize_image', url(1));
        assert.match(result.data.error, /not configured correctly/, `${name}=${value}`);
        assert.equal(fake.log.length, 0, 'nothing is fetched while misconfigured');
    }
});
