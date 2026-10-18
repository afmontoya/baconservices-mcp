// Paying: a real x402 payment (signature verified by the fake Bacon) for exactly the quoted
// request, the outcome recorded in the ledger, and every way it can go wrong.

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { BUYER, connect, imageFile, tempDir } from './helpers.js';
import { createFakeBacon, WEBP } from './fake-bacon.js';

const ledgerOf = (dir) => JSON.parse(readFileSync(join(dir, 'spend-ledger.json'), 'utf8')).entries;

test('optimize_image from a local file: signed, verified, settled, saved, recorded', async () => {
    const dir = tempDir();
    const { call, fake, ledgerDir } = await connect();
    const out = join(dir, 'out.webp');
    const result = await call('optimize_image', { image_path: imageFile(dir), max_width: 800, quality: 70, save_to: out });

    assert.equal(result.error, false, result.text);
    assert.equal(result.data.paid_usdc, '0.01');
    assert.equal(result.data.network, 'eip155:8453');
    assert.match(result.data.transaction_url, /^https:\/\/basescan\.org\/tx\/0x[0-9a-f]{64}$/);
    assert.equal(result.data.artifact.mime, 'image/webp');
    assert.equal(result.data.saved_to, out);
    assert.deepEqual(readFileSync(out), WEBP);

    assert.equal(fake.settled.length, 1, 'exactly one payment settled');
    assert.equal(fake.settled[0].amount, '10000');
    assert.equal(fake.settled[0].from, BUYER.toLowerCase());
    const posts = fake.log.filter((r) => r.method === 'POST');
    assert.equal(posts.length, 2, 'one quote, one paid request');
    assert.equal(posts[0].body, posts[1].body, 'the paid request carries exactly the quoted body');
    assert.deepEqual(Object.keys(JSON.parse(posts[1].body)), ['image_base64', 'max_width', 'quality']);

    const [entry] = ledgerOf(ledgerDir);
    assert.equal(entry.status, 'spent');
    assert.equal(entry.amount, '10000');
    assert.equal(entry.transaction, result.data.transaction);
});

test('remove_background from an image_url', async () => {
    const { call, fake } = await connect();
    const result = await call('remove_background', { image_url: 'https://example.com/photo.jpg' });
    assert.equal(result.error, false, result.text);
    assert.equal(result.data.paid_usdc, '0.2');
    assert.equal(result.data.artifact.mime, 'image/png');
    assert.equal(JSON.parse(fake.log.find((r) => r.paid).body).image_url, 'https://example.com/photo.jpg');
});

test('bad input is refused before any request: both or neither image, http URL, wrong file type, too big, bad option, save_to exists', async () => {
    const dir = tempDir();
    const { call, fake } = await connect();
    const text = join(dir, 'notes.txt');
    (await import('node:fs')).writeFileSync(text, 'not an image');
    const existing = imageFile(dir, 'exists');
    const cases = [
        [{}, /exactly one of image_url or image_path/],
        [{ image_url: 'https://example.com/a.png', image_path: imageFile(dir) }, /exactly one/],
        [{ image_url: 'http://example.com/a.png' }, /public https URL/],
        [{ image_path: text }, /must be PNG, JPEG, WEBP/],
        [{ image_path: join(dir, 'missing.png') }, /cannot be read/],
        [{ image_url: 'https://example.com/a.png', max_width: 10 }, /max_width must be a whole number from 64 to 4096/],
        [{ image_url: 'https://example.com/a.png', quality: 80.5 }, /quality must be a whole number/],
        [{ image_url: 'https://example.com/a.png', save_to: existing }, /already exists/],
        [{ image_url: 'https://example.com/a.png', save_to: join(dir, 'nope', 'x.webp') }, /does not exist/],
        [{ image_url: 'https://example.com/a.png', max_price_usdc: 'cheap' }, /max_price_usdc must be a USDC amount/],
    ];
    for (const [args, message] of cases) {
        const result = await call('optimize_image', args);
        assert.equal(result.error, true, JSON.stringify(args));
        assert.match(result.data.error, message);
        assert.equal(result.data.charged, false);
    }
    assert.equal(fake.log.filter((r) => r.method === 'POST').length, 0);
});

test('an oversized local file is refused against the catalog\'s limit', async () => {
    const dir = tempDir();
    const fake = createFakeBacon();
    fake.catalogEdit = (catalog) => (catalog.capabilities.forEach((c) => { c.limits.max_bytes = 10; }), catalog);
    const { call } = await connect({ fake });
    const result = await call('optimize_image', { image_path: imageFile(dir) });
    assert.match(result.data.error, /Bacon takes at most 10/);
});

test('every way the 402 can disagree with what this package pins is refused before signing', async () => {
    const cases = {
        'price drift': [{ amount: '250000' }, /asks 0\.25 USDC but its catalog lists 0\.2 USDC/],
        'other payee': [{ payTo: '0x1111111111111111111111111111111111111111' }, /not Bacon's receiving address/],
        'other asset': [{ asset: '0x2222222222222222222222222222222222222222' }, /not Base USDC/],
        'other network': [{ network: 'eip155:84532' }, /did not offer an "exact" payment on Base/],
        'other resource': [{ resourceUrl: 'https://baconservices.com/api/agent-commerce/v1/capabilities/web-image-optimizer/execute' }, /payment requirement is for/],
    };
    for (const [label, [tweak, message]] of Object.entries(cases)) {
        const fake = createFakeBacon();
        fake.tweak = tweak;
        const { call } = await connect({ fake });
        const result = await call('remove_background', { image_url: 'https://example.com/a.png' });
        assert.equal(result.error, true, label);
        assert.match(result.data.error, message, label);
        assert.match(result.data.error, /Nothing was signed/, label);
        assert.equal(fake.paymentHeaders.length, 0, `${label}: nothing signed or sent`);
    }
});

test('not enough USDC: refused before signing, with what to do', async () => {
    const { call, fake } = await connect({ balance: 150_000n });
    const result = await call('remove_background', { image_url: 'https://example.com/a.png' });
    assert.equal(result.error, true);
    assert.match(result.data.error, /does not hold 0\.2 USDC on Base\. Add USDC on Base to the wallet/);
    assert.equal(fake.paymentHeaders.length, 0);
});

test('a balance that cannot be read refuses (fails closed)', async () => {
    const fake = createFakeBacon();
    const { call } = await connect({ fake });
    fake.rpcDown = true;
    const result = await call('optimize_image', { image_url: 'https://example.com/a.png' });
    assert.match(result.data.error, /balance on Base could not be checked/);
    assert.equal(fake.paymentHeaders.length, 0);
});

test('the facilitator\'s insufficient_funds is reported plainly and releases the reservation', async () => {
    const fake = createFakeBacon();
    fake.tweak.verify = 'insufficient_funds';
    const { call, ledgerDir, purchaser } = await connect({ fake });
    const result = await call('remove_background', { image_url: 'https://example.com/a.png' });
    assert.equal(result.error, true);
    assert.match(result.data.error, /does not have enough USDC \(insufficient_funds\)\. You have not been charged/);
    assert.equal(result.data.charged, false);
    assert.equal(ledgerOf(ledgerDir)[0].status, 'released');
    assert.equal(purchaser.sessionCommitted, 0n);
});

test('Bacon failing the work before settling releases it; an unknown failure keeps it counted', async () => {
    const released = createFakeBacon();
    released.tweak.executeFailure = [500, { ok: false, code: 'execution_failed', error: 'The capability failed unexpectedly. You have not been charged.' }];
    const a = await connect({ fake: released });
    const first = await a.call('remove_background', { image_url: 'https://example.com/a.png' });
    assert.match(first.data.error, /You have not been charged/);
    assert.equal(ledgerOf(a.ledgerDir)[0].status, 'released');
    assert.equal(a.purchaser.sessionCommitted, 0n);

    const unknown = createFakeBacon();
    unknown.tweak.executeFailure = [502, '<html>Bad gateway</html>'];
    const b = await connect({ fake: unknown });
    const second = await b.call('remove_background', { image_url: 'https://example.com/a.png' });
    assert.equal(second.data.charged, 'unknown');
    assert.match(second.data.error, /may have been charged/);
    assert.equal(ledgerOf(b.ledgerDir)[0].status, 'uncertain');
    assert.equal(b.purchaser.sessionCommitted, 200000n, 'an unknown outcome still counts against the limits');

    const settleFailed = createFakeBacon();
    settleFailed.tweak.settle = 'fail';
    const c = await connect({ fake: settleFailed });
    const third = await c.call('remove_background', { image_url: 'https://example.com/a.png' });
    assert.equal(third.data.charged, 'unknown', 'a 402 carrying a settlement answer is not proof nothing was taken');
    assert.equal(ledgerOf(c.ledgerDir)[0].status, 'uncertain');
});

test('a dropped connection is retried once with the SAME signed payment, and settles once', async () => {
    const fake = createFakeBacon();
    fake.dropAfterProcessing = 1;
    const { call, ledgerDir } = await connect({ fake });
    const result = await call('remove_background', { image_url: 'https://example.com/a.png' });
    assert.equal(result.error, false, result.text);
    assert.equal(fake.paymentHeaders.length, 2, 'sent twice');
    assert.equal(fake.paymentHeaders[0], fake.paymentHeaders[1], 'the very same signed payment, not a new one');
    assert.equal(fake.settled.length, 1, 'charged once');
    assert.equal(ledgerOf(ledgerDir).filter((e) => e.status === 'spent').length, 1);
});

test('a connection that stays down after the retry is recorded as uncertain, never re-signed', async () => {
    const fake = createFakeBacon();
    fake.dropAfterProcessing = 2;
    const { call, ledgerDir } = await connect({ fake });
    const result = await call('remove_background', { image_url: 'https://example.com/a.png' });
    assert.equal(result.data.charged, 'unknown');
    assert.equal(new Set(fake.paymentHeaders).size, 1);
    assert.equal(ledgerOf(ledgerDir)[0].status, 'uncertain');
});

test('the same request again within 10 minutes returns the earlier result and pays nothing; allow_repeat pays again', async () => {
    const dir = tempDir();
    const path = imageFile(dir);
    const { call, fake } = await connect();
    const first = await call('optimize_image', { image_path: path });
    const second = await call('optimize_image', { image_path: path });
    assert.equal(second.error, false);
    assert.equal(second.data.repeat, true);
    assert.match(second.data.note, /not charged again/);
    assert.equal(second.data.artifact.url, first.data.artifact.url);
    assert.equal(fake.settled.length, 1);

    const different = await call('optimize_image', { image_path: path, quality: 60 });
    assert.equal(different.data.repeat, undefined, 'different options are a different request');
    const again = await call('optimize_image', { image_path: path, allow_repeat: true });
    assert.equal(again.data.repeat, undefined);
    assert.equal(fake.settled.length, 3);
});

test('an earlier attempt with an unknown outcome blocks a repeat until allow_repeat', async () => {
    const fake = createFakeBacon();
    fake.dropAfterProcessing = 2;
    const { call } = await connect({ fake });
    await call('optimize_image', { image_url: 'https://example.com/a.png' });
    fake.dropAfterProcessing = 0;
    const repeat = await call('optimize_image', { image_url: 'https://example.com/a.png' });
    assert.equal(repeat.error, true);
    assert.match(repeat.data.error, /outcome is unknown.*may have been charged.*allow_repeat/);
    assert.equal(fake.paymentHeaders.length, 2, 'no new payment');
    const forced = await call('optimize_image', { image_url: 'https://example.com/a.png', allow_repeat: true });
    assert.equal(forced.error, false, forced.text);
});

test('max_price_usdc refuses a higher price', async () => {
    const { call, fake } = await connect();
    const result = await call('remove_background', { image_url: 'https://example.com/a.png', max_price_usdc: 0.1 });
    assert.match(result.data.error, /above the max_price_usdc of 0\.1/);
    assert.equal(fake.paymentHeaders.length, 0);
    const ok = await call('remove_background', { image_url: 'https://example.com/a.png', max_price_usdc: '0.20' });
    assert.equal(ok.error, false, ok.text);
});

test('without a wallet, discovery works and paid tools say how to configure one', async () => {
    const { call, fake } = await connect({ env: { BACON_WALLET_PRIVATE_KEY: '' } });
    assert.equal((await call('list_services')).error, false);
    const result = await call('remove_background', { image_url: 'https://example.com/a.png' });
    assert.match(result.data.error, /No wallet is configured: set BACON_WALLET_PRIVATE_KEY or BACON_WALLET_KEY_FILE/);
    assert.equal(fake.log.filter((r) => r.method === 'POST').length, 0);
    assert.equal(existsSync(join(tempDir(), 'x')), false);
});
