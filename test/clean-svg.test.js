// clean_svg: one SVG in (markup, an https URL, or a local file sent as markup), the cleaned SVG and
// its report out, as JSON inline. The catalog entry is Bacon's own (fixtures/catalog-contract-v1.json,
// dumped from the platform's Capabilities registry on Base).

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { connect, tempDir } from './helpers.js';
import { createFakeBacon } from './fake-bacon.js';

const v1 = () => createFakeBacon({ contract: 'v1' });
const names = async (client) => (await client.listTools()).tools.map((t) => t.name);
const at = (catalog, id) => catalog.capabilities.find((c) => c.id === id);
const MARKUP = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><!-- x --><path d="M 0.0000 0 L 10.0000 0 L 10 10 Z"/></svg>';
const sent = (fake) => fake.log.filter((r) => r.paid).map((r) => JSON.parse(r.body));

test('clean_svg is a tool stating its price, its JSON output, the display cap and its three sources', async () => {
    const { client } = await connect({ fake: v1() });
    const tool = (await client.listTools()).tools.find((t) => t.name === 'clean_svg');
    assert.ok(tool, 'listed as a paid tool');
    assert.match(tool.description, /Costs 0\.01 USDC per call \(real money\) on Base/);
    assert.match(tool.description, /Output: JSON, returned in the tool result\. A result over 256 KB is not shown; pass save_to to keep it\./);
    assert.match(tool.description, /up to 1 MB\. Give exactly one of svg, svg_url or svg_path\./);
    assert.deepEqual(Object.keys(tool.inputSchema.properties), ['svg', 'svg_url', 'svg_path', 'precision', 'simplify', 'keep_ids', 'save_to', 'overwrite', 'max_price_usdc', 'allow_repeat']);
    assert.deepEqual(tool.inputSchema.properties.simplify.enum, ['none', 'light', 'strong']);
    assert.deepEqual([tool.inputSchema.properties.precision.minimum, tool.inputSchema.properties.precision.maximum, tool.inputSchema.properties.precision.default], [1, 6, 3]);
    assert.equal(tool.inputSchema.properties.svg_url.maxLength, 2048);
});

test('a JSON service within the display cap does not carry the note', async () => {
    const { client } = await connect({ fake: v1() });
    const palette = (await client.listTools()).tools.find((t) => t.name === 'image_palette');
    assert.doesNotMatch(palette.description, /is not shown/);
});

test('clean_svg pays 0.01 for a local file sent as svg, with the defaults, and returns the report inline, also saved', async () => {
    const dir = tempDir();
    const fake = v1();
    const { call } = await connect({ fake });
    const file = join(dir, 'logo.svg');
    writeFileSync(file, MARKUP);
    const out = join(dir, 'clean.json');

    const bought = await call('clean_svg', { svg_path: file, save_to: out });

    assert.equal(bought.error, false, bought.text);
    assert.equal(bought.data.paid_usdc, '0.01');
    assert.deepEqual(bought.data.result, at(fake.catalog(), 'svg-cleanup').output.example);
    assert.match(bought.data.result.svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    assert.equal(bought.data.warnings, undefined, 'the example matches the declared schema');
    assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), bought.data.result);
    assert.deepEqual(sent(fake), [{ svg: MARKUP, precision: 3, simplify: 'none', keep_ids: false }]);
    assert.equal(fake.settled[0].amount, '10000');
});

test('svg is sent as given, svg_url as a URL, and the options as chosen', async () => {
    const fake = v1();
    const { call } = await connect({ fake });

    assert.equal((await call('clean_svg', { svg: MARKUP, precision: 2, simplify: 'light', keep_ids: true })).error, false);
    assert.equal((await call('clean_svg', { svg_url: ' https://example.com/a logo.svg ' })).error, false);

    assert.deepEqual(sent(fake), [
        { svg: MARKUP, precision: 2, simplify: 'light', keep_ids: true },
        { svg_url: 'https://example.com/a%20logo.svg', precision: 3, simplify: 'none', keep_ids: false },
    ]);
});

test('the same markup, inline or from a file, is the same request: the repeat is not bought again', async () => {
    const dir = tempDir();
    const fake = v1();
    const { call } = await connect({ fake });
    const file = join(dir, 'same.svg');
    writeFileSync(file, MARKUP);

    await call('clean_svg', { svg: MARKUP });
    const repeat = await call('clean_svg', { svg_path: file });

    assert.equal(repeat.error, false, repeat.text);
    assert.equal(fake.settled.length, 1, 'paid once');
    assert.deepEqual(repeat.data.result, at(fake.catalog(), 'svg-cleanup').output.example);
});

test('a missing, doubled, unreadable, oversized or non-SVG input, or a bad option, is refused before anything is sent', async () => {
    const dir = tempDir();
    const fake = v1();
    const { call } = await connect({ fake });
    const write = (name, data) => {
        const path = join(dir, name);
        writeFileSync(path, data);
        return path;
    };
    const cases = [
        [{}, /exactly one of svg, svg_url or svg_path/],
        [{ svg: '   ' }, /exactly one of svg, svg_url or svg_path/],
        [{ svg: MARKUP, svg_url: 'https://example.com/a.svg' }, /exactly one of svg, svg_url or svg_path/],
        [{ svg_url: 'http://example.com/a.svg' }, /svg_url must be a public https URL/],
        [{ svg_url: 'not a url' }, /svg_url is not a URL/],
        [{ svg_url: `https://example.com/${'a'.repeat(2050)}` }, /svg_url is 2070 characters; Bacon takes at most 2048/],
        [{ svg_path: join(dir, 'missing.svg') }, /svg_path .* cannot be read/],
        [{ svg_path: write('latin1.svg', Buffer.from([0x3c, 0x73, 0x76, 0x67, 0xe9, 0x3e])) }, /svg_path must be a UTF-8 text file/],
        [{ svg_path: write('big.svg', `<svg>${' '.repeat(1048576)}</svg>`) }, /svg_path is 1048587 bytes; Bacon takes at most 1048576/],
        [{ svg: `<svg>${'é'.repeat(524288)}</svg>` }, /The SVG is 1048587 bytes; Bacon takes at most 1048576/],
        [{ svg_path: write('note.txt', 'just text') }, /svg_path does not hold an <svg> element/],
        [{ svg: '<html></html>' }, /svg does not hold an <svg> element/],
        [{ svg: MARKUP, simplify: 'ultra' }, /simplify must be one of: none, light, strong/],
        [{ svg: MARKUP, precision: 7 }, /precision must be a whole number from 1 to 6/],
        [{ svg: MARKUP, keep_ids: 'yes' }, /keep_ids must be true or false/],
    ];
    for (const [args, message] of cases) {
        const refused = await call('clean_svg', args);
        assert.equal(refused.error, true, JSON.stringify(args).slice(0, 80));
        assert.match(refused.data.error, message);
    }
    assert.equal(fake.log.filter((r) => r.method === 'POST').length, 0, 'nothing quoted');
    assert.equal(fake.settled.length, 0);
});

test('a catalog whose svg-cleanup contract differs is not executed', async () => {
    const changes = {
        'version 2': (c) => { at(c, 'svg-cleanup').version = 2; },
        'svg_url removed': (c) => { delete at(c, 'svg-cleanup').input.properties.svg_url; },
        'another simplify list': (c) => { at(c, 'svg-cleanup').input.properties.simplify.enum.push('extreme'); },
        'another precision bound': (c) => { at(c, 'svg-cleanup').input.properties.precision.maximum = 8; },
        'an image format declared': (c) => { at(c, 'svg-cleanup').limits.formats = ['image/svg+xml', 'image/png']; },
        'no response cap': (c) => { delete at(c, 'svg-cleanup').limits.max_response_bytes; },
        'an artifact instead': (c) => { at(c, 'svg-cleanup').output.kind = 'artifact'; },
    };
    for (const [label, change] of Object.entries(changes)) {
        const fake = v1();
        fake.catalogEdit = (catalog) => (change(catalog), catalog);
        const { client, call } = await connect({ fake });
        assert.equal((await names(client)).includes('clean_svg'), false, label);
        assert.equal((await call('clean_svg', { svg: MARKUP })).error, true, label);
        assert.equal(fake.log.filter((r) => r.paid).length, 0, label);
    }
    const fake = v1();
    fake.catalogEdit = (catalog) => (at(catalog, 'svg-cleanup').limits.formats = ['image/png'], catalog);
    const { call } = await connect({ fake });
    const listed = (await call('list_services')).data.services.find((s) => s.id === 'svg-cleanup');
    assert.match(listed.not_executable_because.join('; '), /input formats are missing or not SVG/);
});
