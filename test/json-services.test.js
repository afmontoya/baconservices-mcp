// The catalog with contract fields (contract_version 1): URL input (brand_from_url) and JSON
// results (image_palette, brand_from_url), and the rules that keep a service the package does not
// fully understand from being executed.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { payTimeoutMs } from '../src/payment.js';
import { connect, imageFile, tempDir } from './helpers.js';
import { createFakeBacon } from './fake-bacon.js';

const v1 = () => createFakeBacon({ contract: 'v1' });
const names = async (client) => (await client.listTools()).tools.map((t) => t.name);
const ledgerOf = (dir) => JSON.parse(readFileSync(join(dir, 'spend-ledger.json'), 'utf8')).entries;
const SITE = { url: 'https://example.com/' };

test('a contract-v1 catalog makes all five known services tools, each stating its price and output', async () => {
    const { client } = await connect({ fake: v1() });
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name), ['list_services', 'quote', 'wallet_status', 'remove_background', 'optimize_image', 'image_palette', 'brand_from_url', 'vectorize_image']);
    const brand = tools.find((t) => t.name === 'brand_from_url');
    assert.match(brand.description, /Costs 0\.03 USDC per call \(real money\) on Base/);
    assert.match(brand.description, /Output: JSON, returned in the tool result\./);
    assert.deepEqual(Object.keys(brand.inputSchema.properties), ['url', 'save_to', 'overwrite', 'max_price_usdc', 'allow_repeat']);
    assert.equal(brand.inputSchema.properties.url.maxLength, 2048);
    const palette = tools.find((t) => t.name === 'image_palette');
    assert.match(palette.description, /Costs 0\.01 USDC/);
    assert.deepEqual(Object.keys(palette.inputSchema.properties), ['image_url', 'image_path', 'count', 'include_neutrals', 'save_to', 'overwrite', 'max_price_usdc', 'allow_repeat']);
    assert.equal(palette.inputSchema.properties.include_neutrals.type, 'boolean');
    const remove = tools.find((t) => t.name === 'remove_background');
    assert.match(remove.description, /Output: image\/png, as a download link/);
});

test('today\'s production catalog (no contract fields) keeps the two image tools; the JSON services need the fields', async () => {
    assert.deepEqual(await names((await connect()).client), ['list_services', 'quote', 'wallet_status', 'remove_background', 'optimize_image']);

    // The new services listed in a catalog without contract fields: listed, never executable.
    const fake = createFakeBacon();
    const newer = createFakeBacon({ contract: 'v1' }).catalog().capabilities.slice(2).map((c) => {
        const { input_version: _i, output_version: _o, ...rest } = c;
        return rest;
    });
    fake.catalogEdit = (catalog) => (catalog.capabilities.push(...newer), catalog);
    const { client, call } = await connect({ fake });
    assert.deepEqual(await names(client), ['list_services', 'quote', 'wallet_status', 'remove_background', 'optimize_image']);
    const brand = (await call('list_services')).data.services.find((s) => s.id === 'brand-from-url');
    assert.equal(brand.executable, false);
    assert.match(brand.not_executable_because[0], /does not declare contract versions/);
});

test('a catalog contract_version this package does not know makes nothing executable', async () => {
    const fake = v1();
    fake.catalogEdit = (catalog) => ({ ...catalog, contract_version: 2 });
    const { client, call } = await connect({ fake });
    assert.deepEqual(await names(client), ['list_services', 'quote', 'wallet_status']);
    const listed = await call('list_services');
    assert.ok(listed.data.services.every((s) => !s.executable));
    assert.match(listed.data.services[0].not_executable_because[0], /contract_version 2 is not one this package understands/);
    assert.equal((await call('remove_background', { image_url: 'https://example.com/a.png' })).error, true);
    assert.equal(fake.log.filter((r) => r.method === 'POST').length, 0);
});

test('every contract field a v1 entry must carry, changed or missing, stops it being executable', async () => {
    const at = (catalog, id) => catalog.capabilities.find((c) => c.id === id);
    const cases = {
        'input_version 2': (c) => { at(c, 'brand-from-url').input_version = 2; },
        'output_version 2': (c) => { at(c, 'brand-from-url').output_version = 2; },
        'input_version missing': (c) => { delete at(c, 'brand-from-url').input_version; },
        'kind artifact': (c) => { at(c, 'brand-from-url').output.kind = 'artifact'; },
        'kind missing': (c) => { delete at(c, 'brand-from-url').output.kind; },
        'no schema': (c) => { delete at(c, 'brand-from-url').output.schema; },
        'no max_response_bytes': (c) => { delete at(c, 'brand-from-url').limits.max_response_bytes; },
        'no max_request_bytes': (c) => { delete at(c, 'brand-from-url').limits.max_request_bytes; },
        'bad max_seconds': (c) => { at(c, 'brand-from-url').limits.max_seconds = 'soon'; },
        'url not required': (c) => { at(c, 'brand-from-url').input.required = []; },
        'extra input': (c) => { at(c, 'brand-from-url').input.properties.depth = { type: 'integer' }; },
        'image input instead': (c) => { at(c, 'brand-from-url').input.properties = { image_url: { type: 'string' }, image_base64: { type: 'string' } }; },
        'version 2': (c) => { at(c, 'brand-from-url').version = 2; },
    };
    for (const [label, edit] of Object.entries(cases)) {
        const fake = v1();
        fake.catalogEdit = (catalog) => (edit(catalog), catalog);
        const { client, call } = await connect({ fake });
        assert.equal((await names(client)).includes('brand_from_url'), false, label);
        const attempt = await call('brand_from_url', SITE);
        assert.match(attempt.data.error, /cannot be run by this version of the package/, label);
        assert.equal(fake.log.filter((r) => r.method === 'POST').length, 0, `${label}: nothing quoted`);
    }

    const palette = v1();
    palette.catalogEdit = (catalog) => (at(catalog, 'image-palette').input.properties.count.maximum = 50, catalog);
    assert.equal((await names((await connect({ fake: palette })).client)).includes('image_palette'), false, 'a widened option bound');
    const neutrals = v1();
    neutrals.catalogEdit = (catalog) => (at(catalog, 'image-palette').input.properties.include_neutrals.default = false, catalog);
    assert.equal((await names((await connect({ fake: neutrals })).client)).includes('image_palette'), false, 'a changed boolean default');
});

test('brand_from_url: pays 0.03 for exactly {url} and returns the JSON result inline, also saved', async () => {
    const dir = tempDir();
    const fake = v1();
    const { call, ledgerDir } = await connect({ fake });
    const out = join(dir, 'brand.json');
    const bought = await call('brand_from_url', { url: 'https://example.com', save_to: out });
    assert.equal(bought.error, false, bought.text);
    assert.equal(bought.data.paid_usdc, '0.03');
    assert.equal(bought.data.result.name, 'Bacon Services');
    assert.deepEqual(bought.data.result, fake.catalog().capabilities[3].output.example);
    assert.equal(bought.data.warnings, undefined, 'the example matches the declared schema');
    assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), bought.data.result);
    assert.deepEqual(fake.log.filter((r) => r.paid).map((r) => JSON.parse(r.body)), [{ url: 'https://example.com/' }]);
    assert.equal(fake.settled[0].amount, '30000');
    const [entry] = ledgerOf(ledgerDir);
    assert.equal(entry.status, 'spent');
    assert.deepEqual(entry.result, bought.data.result);
});

test('image_palette from a local file sends the options with their defaults and returns colours', async () => {
    const dir = tempDir();
    const fake = v1();
    const { call } = await connect({ fake });
    const bought = await call('image_palette', { image_path: imageFile(dir), count: 3 });
    assert.equal(bought.error, false, bought.text);
    assert.equal(bought.data.paid_usdc, '0.01');
    assert.equal(bought.data.result.colors.length, 3);
    const sent = JSON.parse(fake.log.find((r) => r.paid).body);
    assert.deepEqual(Object.keys(sent), ['image_base64', 'count', 'include_neutrals']);
    assert.equal(sent.count, 3);
    assert.equal(sent.include_neutrals, true);
    assert.match((await call('image_palette', { image_path: imageFile(dir, 'b'), include_neutrals: 'no' })).data.error, /include_neutrals must be true or false/);
});

test('a URL that is not one public web page is refused before any request', async () => {
    const fake = v1();
    const { call } = await connect({ fake });
    const cases = [
        [{}, /Give url/],
        [{ url: 'ftp://example.com/' }, /http or https/],
        [{ url: 'https://user:pass@example.com/' }, /user name or password/],
        [{ url: 'https://example.com:8443/' }, /standard port/],
        [{ url: `https://example.com/${'a'.repeat(2050)}` }, /at most 2048/],
        [{ url: 'not a url' }, /not a URL/],
    ];
    for (const [args, message] of cases) {
        const result = await call('brand_from_url', args);
        assert.match(result.data.error, message, JSON.stringify(args).slice(0, 60));
        assert.equal(result.data.charged, false);
    }
    assert.equal(fake.log.filter((r) => r.method === 'POST').length, 0);
});

test('a request larger than the declared max_request_bytes is refused before sending', async () => {
    const dir = tempDir();
    const fake = v1();
    fake.catalogEdit = (catalog) => (catalog.capabilities.find((c) => c.id === 'image-palette').limits.max_request_bytes = 40, catalog);
    const { call } = await connect({ fake });
    const result = await call('image_palette', { image_path: imageFile(dir) });
    assert.match(result.data.error, /Bacon takes at most 40 for image_palette\. Nothing was sent/);
    assert.equal(fake.log.filter((r) => r.method === 'POST').length, 0);
});

test('a JSON result over max_response_bytes is paid but not handed to the model; save_to still keeps it', async () => {
    const dir = tempDir();
    const fake = v1();
    fake.tweak.jsonResult = { ...fake.catalog().capabilities[3].output.example, description: 'x'.repeat(70_000) };
    const { call, ledgerDir } = await connect({ fake });
    const shown = await call('brand_from_url', SITE);
    assert.equal(shown.error, false);
    assert.equal(shown.data.result, null);
    assert.match(shown.data.warnings[0], /above the 65536 bytes this service declares, so it is not shown/);
    assert.ok(shown.text.length < 5000, 'the oversized text never reaches the tool result');
    assert.equal(ledgerOf(ledgerDir)[0].result, undefined, 'and is not kept in the ledger');

    const out = join(dir, 'big.json');
    const saved = await call('brand_from_url', { url: 'https://example.org/', save_to: out });
    assert.equal(saved.data.saved_to, out);
    assert.equal(JSON.parse(readFileSync(out, 'utf8')).description.length, 70_000);

    const repeat = await call('brand_from_url', SITE);
    assert.match(repeat.data.error, /too large to keep\. Pass allow_repeat/);
    assert.equal(fake.settled.length, 2, 'the repeat did not pay');
});

test('the package\'s own 256 KB ceiling holds even when a service declares more', async () => {
    const fake = v1();
    fake.catalogEdit = (catalog) => (catalog.capabilities.find((c) => c.id === 'brand-from-url').limits.max_response_bytes = 10_000_000, catalog);
    fake.tweak.jsonResult = { ...fake.catalog().capabilities[3].output.example, description: 'x'.repeat(300_000) };
    const { call } = await connect({ fake });
    const shown = await call('brand_from_url', SITE);
    assert.equal(shown.data.result, null);
    assert.match(shown.data.warnings[0], /above the 262144 bytes/);
});

test('a JSON result that breaks the declared schema is delivered with a warning', async () => {
    const fake = v1();
    fake.tweak.jsonResult = { colors: 'not a list' };
    const { call } = await connect({ fake });
    const bought = await call('image_palette', { image_url: 'https://example.com/a.png' });
    assert.equal(bought.error, false);
    assert.deepEqual(bought.data.result, { colors: 'not a list' });
    assert.match(bought.data.warnings[0], /does not match the service's declared output schema \(\/result /);
});

test('the same page again within 10 minutes returns the stored JSON result without paying', async () => {
    const fake = v1();
    const { call } = await connect({ fake });
    const first = await call('brand_from_url', SITE);
    const second = await call('brand_from_url', SITE);
    assert.equal(second.data.repeat, true);
    assert.deepEqual(second.data.result, first.data.result);
    assert.equal(fake.settled.length, 1);
});

test('the JSON result is dropped from the ledger once the repeat window has passed', async () => {
    let clock = Date.parse('2026-10-17T12:00:00Z');
    const fake = v1();
    const { call, ledgerDir } = await connect({ fake, now: () => clock });
    await call('brand_from_url', SITE);
    assert.ok(ledgerOf(ledgerDir)[0].result);
    clock += 11 * 60 * 1000;
    await call('brand_from_url', { url: 'https://example.org/' });
    const entries = ledgerOf(ledgerDir);
    assert.equal(entries[0].result, undefined);
    assert.ok(entries[1].result, 'the new one is kept for its own window');
});

test('brand_from_url refusals: a per-host limit at quote time pays nothing; busy or failed after payment is not charged; 410 counts', async () => {
    const atQuote = v1();
    atQuote.tweak.hostBusyAtQuote = true;
    const a = await connect({ fake: atQuote });
    const quoted = await a.call('brand_from_url', SITE);
    assert.match(quoted.data.error, /refused the request before any payment \(503 This site has been read too often/);
    assert.equal(atQuote.paymentHeaders.length, 0);

    for (const [status, code] of [[503, 'busy'], [422, 'execution_failed']]) {
        const fake = v1();
        fake.tweak.executeFailure = [status, { ok: false, code, error: 'robots.txt disallows this page. You have not been charged.' }];
        const { call, ledgerDir, purchaser } = await connect({ fake });
        const result = await call('brand_from_url', SITE);
        assert.equal(result.data.charged, false, code);
        assert.equal(ledgerOf(ledgerDir)[0].status, 'released', code);
        assert.equal(purchaser.sessionCommitted, 0n, code);
    }

    const expired = v1();
    expired.tweak.executeFailure = [410, { ok: false, code: 'result_expired', error: 'This result is no longer available.' }];
    const c = await connect({ fake: expired });
    const gone = await c.call('brand_from_url', SITE);
    assert.equal(gone.data.charged, 'unknown');
    assert.equal(ledgerOf(c.ledgerDir)[0].status, 'uncertain');
});

test('the paid-call timeout follows the declared max_seconds', () => {
    assert.equal(payTimeoutMs({ limits: { max_seconds: 50 } }), 80_000);
    assert.equal(payTimeoutMs({ limits: { max_seconds: 15 } }), 45_000);
    assert.equal(payTimeoutMs({ limits: {} }), 120_000);
});

test('the image tools still buy normally from a contract-v1 catalog', async () => {
    const fake = v1();
    const { call } = await connect({ fake });
    const result = await call('optimize_image', { image_url: 'https://example.com/a.png' });
    assert.equal(result.error, false, result.text);
    assert.equal(result.data.artifact.mime, 'image/webp');
});
