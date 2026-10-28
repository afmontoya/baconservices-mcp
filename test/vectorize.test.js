// vectorize_image: an image in, an SVG artifact out, with the first named-value (enum) option.
// The catalog entry is Bacon's own (fixtures/catalog-contract-v1.json, dumped from the platform's
// Capabilities registry on Base).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { connect, imageFile, tempDir } from './helpers.js';
import { createFakeBacon, SVG } from './fake-bacon.js';

const v1 = () => createFakeBacon({ contract: 'v1' });
const names = async (client) => (await client.listTools()).tools.map((t) => t.name);
const at = (catalog, id) => catalog.capabilities.find((c) => c.id === id);

test('vectorize_image is a tool stating its price, its SVG output and the detail choices', async () => {
    const { client } = await connect({ fake: v1() });
    const tool = (await client.listTools()).tools.find((t) => t.name === 'vectorize_image');
    assert.ok(tool, 'listed as a paid tool');
    assert.match(tool.description, /Costs 0\.05 USDC per call \(real money\) on Base/);
    assert.match(tool.description, /Output: image\/svg\+xml, as a download link/);
    assert.match(tool.description, /at most 8000 px/);
    assert.deepEqual(Object.keys(tool.inputSchema.properties), ['image_url', 'image_path', 'colors', 'detail', 'save_to', 'overwrite', 'max_price_usdc', 'allow_repeat']);
    assert.deepEqual(tool.inputSchema.properties.detail.enum, ['smooth', 'balanced', 'detailed']);
    assert.equal(tool.inputSchema.properties.detail.default, 'balanced');
    assert.deepEqual([tool.inputSchema.properties.colors.minimum, tool.inputSchema.properties.colors.maximum], [2, 32]);
});

test('vectorize_image pays 0.05, sends the options with their defaults and saves the SVG', async () => {
    const dir = tempDir();
    const fake = v1();
    const { call } = await connect({ fake });
    const out = join(dir, 'logo.svg');

    const bought = await call('vectorize_image', { image_path: imageFile(dir), detail: 'smooth', save_to: out });

    assert.equal(bought.error, false, bought.text);
    assert.equal(bought.data.paid_usdc, '0.05');
    assert.equal(bought.data.artifact.mime, 'image/svg+xml');
    assert.equal(bought.data.warnings, undefined);
    assert.equal(bought.data.saved_to, out);
    assert.deepEqual(readFileSync(out), SVG);
    const sent = JSON.parse(fake.log.find((r) => r.paid).body);
    assert.deepEqual(Object.keys(sent), ['image_base64', 'colors', 'detail']);
    assert.deepEqual([sent.colors, sent.detail], [16, 'smooth']);
    assert.equal(fake.settled[0].amount, '50000');
});

test('a detail outside the list, or colors out of bounds, is refused before anything is sent', async () => {
    const dir = tempDir();
    const fake = v1();
    const { call } = await connect({ fake });

    assert.match((await call('vectorize_image', { image_path: imageFile(dir, 'a'), detail: 'ultra' })).data.error, /detail must be one of: smooth, balanced, detailed/);
    assert.match((await call('vectorize_image', { image_path: imageFile(dir, 'b'), detail: 2 })).data.error, /detail must be one of/);
    assert.match((await call('vectorize_image', { image_path: imageFile(dir, 'c'), colors: 33 })).data.error, /colors must be a whole number from 2 to 32/);
    assert.equal(fake.log.filter((r) => r.method === 'POST').length, 0, 'nothing quoted');
    assert.equal(fake.settled.length, 0);
});

test('a catalog whose detail choices differ in any way is not executed', async () => {
    const edits = {
        'a value added': (p) => p.enum.push('ultra'),
        'a value removed': (p) => p.enum.pop(),
        'the order changed': (p) => p.enum.reverse(),
        'no list at all': (p) => delete p.enum,
        'another default': (p) => (p.default = 'smooth'),
    };
    for (const [label, edit] of Object.entries(edits)) {
        const fake = v1();
        fake.catalogEdit = (catalog) => (edit(at(catalog, 'vectorize').input.properties.detail), catalog);
        const { client, call } = await connect({ fake });

        assert.equal((await names(client)).includes('vectorize_image'), false, label);
        const listed = (await call('list_services')).data.services.find((s) => s.id === 'vectorize');
        assert.equal(listed.executable, false, label);
        assert.match(listed.not_executable_because.join('; '), /input detail\.(enum|default)/, label);
    }
});
