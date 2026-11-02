// accessibility_check: a public page's URL in, an automated WCAG check out, as JSON inline, with two
// named-value options. The catalog entry is Bacon's own (fixtures/catalog-contract-v1.json, dumped
// from the platform's Capabilities registry on Base).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connect } from './helpers.js';
import { createFakeBacon } from './fake-bacon.js';

const v1 = () => createFakeBacon({ contract: 'v1' });
const names = async (client) => (await client.listTools()).tools.map((t) => t.name);
const at = (catalog, id) => catalog.capabilities.find((c) => c.id === id);

test('accessibility_check is a tool stating its price, JSON output and both choices', async () => {
    const { client } = await connect({ fake: v1() });
    const tool = (await client.listTools()).tools.find((t) => t.name === 'accessibility_check');
    assert.ok(tool, 'listed as a paid tool');
    assert.match(tool.description, /Costs 0\.05 USDC per call \(real money\) on Base/);
    assert.match(tool.description, /Not a certification of WCAG or ADA conformance/);
    assert.deepEqual(Object.keys(tool.inputSchema.properties), ['url', 'standard', 'viewport', 'save_to', 'overwrite', 'max_price_usdc', 'allow_repeat']);
    assert.deepEqual([tool.inputSchema.properties.standard.enum, tool.inputSchema.properties.standard.default], [['wcag22aa', 'wcag21aa'], 'wcag22aa']);
    assert.deepEqual(tool.inputSchema.properties.viewport.enum, ['desktop', 'mobile']);
});

test('accessibility_check pays 0.05, sends the options with their defaults and returns the check inline', async () => {
    const fake = v1();
    const { call } = await connect({ fake });
    const bought = await call('accessibility_check', { url: 'https://example.com', viewport: 'mobile' });
    assert.equal(bought.error, false, bought.text);
    assert.equal(bought.data.paid_usdc, '0.05');
    assert.deepEqual(bought.data.result, at(fake.catalog(), 'accessibility-check').output.example);
    assert.equal(bought.data.warnings, undefined, 'the example matches the declared schema');
    assert.deepEqual(fake.log.filter((r) => r.paid).map((r) => JSON.parse(r.body)), [{ url: 'https://example.com/', standard: 'wcag22aa', viewport: 'mobile' }]);
    assert.equal(fake.settled[0].amount, '50000');
});

test('a standard outside the list is refused before anything is sent', async () => {
    const fake = v1();
    const { call } = await connect({ fake });
    const result = await call('accessibility_check', { url: 'https://example.com/', standard: 'wcag30' });
    assert.match(result.data.error, /standard must be one of: wcag22aa, wcag21aa/);
    assert.equal(fake.log.filter((r) => r.method === 'POST').length, 0);
});

test('a catalog whose accessibility-check choices differ is not executed', async () => {
    const changes = {
        'a standard added': (c) => { at(c, 'accessibility-check').input.properties.standard.enum.push('wcag30'); },
        'another default': (c) => { at(c, 'accessibility-check').input.properties.viewport.default = 'mobile'; },
        'version 2': (c) => { at(c, 'accessibility-check').version = 2; },
    };
    for (const [label, change] of Object.entries(changes)) {
        const fake = v1();
        fake.catalogEdit = (catalog) => (change(catalog), catalog);
        const { client, call } = await connect({ fake });
        assert.equal((await names(client)).includes('accessibility_check'), false, label);
        assert.equal((await call('accessibility_check', { url: 'https://example.com/' })).error, true, label);
        assert.equal(fake.log.filter((r) => r.paid).length, 0, label);
    }
});
