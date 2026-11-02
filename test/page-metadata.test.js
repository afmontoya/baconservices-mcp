// page_metadata: a public page's URL in, its SEO and link-preview metadata out, as JSON inline.
// The catalog entry is Bacon's own (fixtures/catalog-contract-v1.json, dumped from the platform's
// Capabilities registry on Base).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { connect, tempDir } from './helpers.js';
import { createFakeBacon } from './fake-bacon.js';

const v1 = () => createFakeBacon({ contract: 'v1' });
const names = async (client) => (await client.listTools()).tools.map((t) => t.name);
const at = (catalog, id) => catalog.capabilities.find((c) => c.id === id);

test('page_metadata is a tool stating its price and JSON output, taking only url', async () => {
    const { client } = await connect({ fake: v1() });
    const tool = (await client.listTools()).tools.find((t) => t.name === 'page_metadata');
    assert.ok(tool, 'listed as a paid tool');
    assert.match(tool.description, /Costs 0\.01 USDC per call \(real money\) on Base/);
    assert.match(tool.description, /Output: JSON, returned in the tool result\./);
    assert.deepEqual(Object.keys(tool.inputSchema.properties), ['url', 'save_to', 'overwrite', 'max_price_usdc', 'allow_repeat']);
});

test('page_metadata pays 0.01 for exactly {url} and returns the reading inline, also saved', async () => {
    const dir = tempDir();
    const fake = v1();
    const { call } = await connect({ fake });
    const out = join(dir, 'meta.json');
    const bought = await call('page_metadata', { url: 'https://example.com', save_to: out });
    assert.equal(bought.error, false, bought.text);
    assert.equal(bought.data.paid_usdc, '0.01');
    assert.deepEqual(bought.data.result, at(fake.catalog(), 'page-metadata').output.example);
    assert.equal(bought.data.result.title.text, 'Online Image & Vector Editor for Designers | Bacon Services');
    assert.equal(bought.data.warnings, undefined, 'the example matches the declared schema');
    assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), bought.data.result);
    assert.deepEqual(fake.log.filter((r) => r.paid).map((r) => JSON.parse(r.body)), [{ url: 'https://example.com/' }]);
    assert.equal(fake.settled[0].amount, '10000');
});

test('a catalog whose page-metadata contract differs is not executed', async () => {
    const changes = {
        'version 2': (c) => { at(c, 'page-metadata').version = 2; },
        'an option added': (c) => { at(c, 'page-metadata').input.properties.depth = { type: 'integer' }; },
        'an artifact instead': (c) => { at(c, 'page-metadata').output.kind = 'artifact'; },
    };
    for (const [label, change] of Object.entries(changes)) {
        const fake = v1();
        fake.catalogEdit = (catalog) => (change(catalog), catalog);
        const { client, call } = await connect({ fake });
        assert.equal((await names(client)).includes('page_metadata'), false, label);
        assert.equal((await call('page_metadata', { url: 'https://example.com/' })).error, true, label);
        assert.equal(fake.log.filter((r) => r.paid).length, 0, label);
    }
});
