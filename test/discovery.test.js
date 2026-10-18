// Discovery: which tools exist comes from the live catalog, but only contracts this package
// understands become executable.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { connect } from './helpers.js';
import { createFakeBacon } from './fake-bacon.js';

const names = async (client) => (await client.listTools()).tools.map((t) => t.name);

test('the live catalog\'s known services become paid tools that state their price', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name), ['list_services', 'quote', 'wallet_status', 'remove_background', 'optimize_image']);
    const remove = tools.find((t) => t.name === 'remove_background');
    assert.match(remove.description, /Costs 0\.2 USDC per call \(real money\) on Base/);
    assert.deepEqual(Object.keys(remove.inputSchema.properties), ['image_url', 'image_path', 'save_to', 'overwrite', 'max_price_usdc', 'allow_repeat']);
    assert.ok(!('private_key' in remove.inputSchema.properties) && !JSON.stringify(tools).match(/private|secret|wallet_key/i), 'no tool takes key material');
    const optimize = tools.find((t) => t.name === 'optimize_image');
    assert.match(optimize.description, /Costs 0\.01 USDC per call/);
    assert.deepEqual(optimize.inputSchema.properties.max_width, { type: 'integer', minimum: 64, maximum: 4096, default: 1600, description: 'Longest side of the output, in pixels.' });
});

test('a service with a contract this package does not know is listed but never executable', async () => {
    const fake = createFakeBacon();
    fake.catalogEdit = (catalog) => {
        const brand = structuredClone(catalog.capabilities[0]);
        Object.assign(brand, { id: 'logo-maker', name: 'Logo Maker', endpoint: { method: 'POST', url: 'https://baconservices.com/api/agent-commerce/v1/capabilities/logo-maker/execute' } });
        catalog.capabilities.push(brand);
        return catalog;
    };
    const { client, call } = await connect({ fake });
    const listed = await call('list_services');
    const brand = listed.data.services.find((s) => s.id === 'logo-maker');
    assert.equal(brand.executable, false);
    assert.equal(brand.tool, null);
    assert.equal(brand.contract, 'logo-maker@1');
    assert.match(brand.not_executable_because[0], /does not know the contract logo-maker@1/);
    assert.equal((await names(client)).includes('logo_maker'), false);
    const attempt = await call('logo_maker', { image_url: 'https://example.com/a.png' });
    assert.equal(attempt.error, true);
    assert.equal(fake.paidRequests(), 0);
});

test('a new version or a changed input/output contract of a known service stops it being executable', async () => {
    const cases = {
        'version 2': (c) => { c.capabilities[1].version = 2; },
        'wider max_width': (c) => { c.capabilities[1].input.properties.max_width.maximum = 8000; },
        'extra input': (c) => { c.capabilities[1].input.properties.background = { type: 'string' }; },
        'other output': (c) => { c.capabilities[1].output.mime = 'image/avif'; },
        'async': (c) => { c.capabilities[1].execution = 'async'; },
        'no size limit': (c) => { delete c.capabilities[1].limits.max_bytes; },
        'other asset': (c) => { c.capabilities[1].price.asset = '0x0000000000000000000000000000000000000001'; },
        'other endpoint': (c) => { c.capabilities[1].endpoint.url = 'https://evil.example/execute'; },
    };
    for (const [label, edit] of Object.entries(cases)) {
        const fake = createFakeBacon();
        fake.catalogEdit = (catalog) => (edit(catalog), catalog);
        const { client, call } = await connect({ fake });
        assert.deepEqual(await names(client), ['list_services', 'quote', 'wallet_status', 'remove_background'], label);
        const listed = (await call('list_services')).data.services.find((s) => s.id === 'web-image-optimizer');
        assert.equal(listed.executable, false, label);
        const attempt = await call('optimize_image', { image_url: 'https://example.com/a.png' });
        assert.equal(attempt.error, true, label);
        assert.match(attempt.data.error, /cannot be run by this version of the package/, label);
        assert.equal(fake.log.filter((r) => r.method === 'POST').length, 0, `${label}: nothing was even quoted`);
    }
});

test('the client is told when the executable tools change', async () => {
    const fake = createFakeBacon();
    const { client, call } = await connect({ fake });
    let notified = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
        notified += 1;
    });
    assert.equal((await names(client)).length, 5);

    await call('list_services');
    assert.equal(notified, 0, 'nothing changed');

    fake.catalogEdit = (catalog) => ({ ...catalog, capabilities: catalog.capabilities.filter((c) => c.id !== 'remove-background') });
    await call('list_services');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(notified, 1);
    assert.deepEqual(await names(client), ['list_services', 'quote', 'wallet_status', 'optimize_image']);
});

test('a closed or unreachable catalog leaves only the free tools, which explain why', async () => {
    const fake = createFakeBacon();
    fake.tweak.catalogClosed = true;
    const { client, call } = await connect({ fake });
    assert.deepEqual(await names(client), ['list_services', 'quote', 'wallet_status']);
    const listed = await call('list_services');
    assert.equal(listed.error, true);
    assert.match(listed.data.error, /not selling services to agents right now/);
});

test('quote gives Bacon\'s authoritative price and the limits verdict without signing anything', async () => {
    const { call, fake } = await connect({ env: { BACON_MAX_PER_CALL: '0.10' } });
    const quote = await call('quote', { service: 'remove_background' });
    assert.equal(quote.error, false);
    assert.equal(quote.data.price_usdc, '0.2');
    assert.equal(quote.data.network, 'eip155:8453');
    assert.equal(quote.data.pay_to_verified, true);
    assert.equal(quote.data.within_limits, false);
    assert.match(quote.data.limit_problems[0], /above your per-call limit of 0\.1 USDC/);
    assert.equal(quote.data.sufficient_balance, 'yes');
    assert.equal(fake.paidRequests(), 0);
    assert.deepEqual(fake.log.filter((r) => r.method === 'POST').map((r) => r.body), ['{}'], 'an empty probe: no image is sent to quote');

    const byId = await call('quote', { service: 'web-image-optimizer' });
    assert.equal(byId.data.price_usdc, '0.01');
    assert.equal(byId.data.within_limits, true);
});

test('a purchase re-reads the catalog: a price changed after listing is paid at the new, verified price', async () => {
    const fake = createFakeBacon();
    const { client, call } = await connect({ fake });
    await client.listTools(); // the catalog is now cached at 0.2
    fake.catalogEdit = (catalog) => (catalog.capabilities[0].price.amount = '150000', catalog);
    const result = await call('remove_background', { image_url: 'https://example.com/a.png' });
    assert.equal(result.error, false, result.text);
    assert.equal(result.data.paid_usdc, '0.15');
    assert.equal(fake.settled[0].amount, '150000');
});

test('quote refuses a price that differs from the catalog', async () => {
    const fake = createFakeBacon();
    fake.tweak.amount = '300000';
    const { call } = await connect({ fake });
    const quote = await call('quote', { service: 'remove_background' });
    assert.equal(quote.error, true);
    assert.match(quote.data.error, /asks 0\.3 USDC but its catalog lists 0\.2 USDC/);
});
