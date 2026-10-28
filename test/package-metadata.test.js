// What registries and npm show: the Registry's server.json must name the package npm publishes,
// at its version, and its one line must fit the Registry's limit and name every paid tool.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { CONTRACTS } from '../src/contracts.js';
import { createFakeBacon } from './fake-bacon.js';
import { connect } from './helpers.js';

const json = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const pkg = json('../package.json');
const server = json('../registry/server.json');

// How each paid tool is named in the one-line descriptions.
const NAMED_AS = {
    remove_background: /background/i,
    optimize_image: /WebP|optimi[sz]e/i,
    image_palette: /palette/i,
    brand_from_url: /brand/i,
    vectorize_image: /SVG/,
};

test('the Registry entry is the npm package at its version', () => {
    assert.equal(server.name, pkg.mcpName);
    assert.equal(server.version, pkg.version);
    assert.deepEqual(server.packages.map((p) => [p.registryType, p.identifier, p.version]), [['npm', pkg.name, pkg.version]]);
});

test('the one-line descriptions fit and name every paid tool', () => {
    assert.ok(server.description.length <= 100, `the Registry caps it at 100 characters: ${server.description.length}`);
    assert.deepEqual(Object.keys(NAMED_AS), CONTRACTS.map((c) => c.tool), 'every paid tool has a way to be named');
    for (const [tool, words] of Object.entries(NAMED_AS)) {
        assert.match(server.description, words, `server.json names ${tool}`);
        assert.match(pkg.description, words, `package.json names ${tool}`);
    }
});

// The MCPB bundle (Smithery, MCPB-aware apps): scripts/build-mcpb.sh packs mcpb/manifest.json.
const manifest = json('../mcpb/manifest.json');

test('the MCPB manifest is this package: its version, its entry point and every tool it lists', async () => {
    assert.equal(manifest.version, pkg.version);
    assert.equal(manifest.name, pkg.name);
    assert.equal(manifest.server.entry_point, Object.values(pkg.bin)[0].replace(/^\.\//, ''));
    assert.deepEqual(manifest.server.mcp_config.args, [`\${__dirname}/${manifest.server.entry_point}`]);
    const { client } = await connect({ fake: createFakeBacon({ contract: 'v1' }) });
    const listed = (await client.listTools()).tools.map((t) => t.name);
    assert.deepEqual(manifest.tools.map((t) => t.name), listed, 'the free tools and every paid tool, in the order the server lists them');
    assert.deepEqual(manifest.compatibility.runtimes.node.replace(/\.0\.0$/, ''), pkg.engines.node);
});

test('the MCPB settings are exactly the Registry\'s environment variables, with the same defaults', () => {
    const env = manifest.server.mcp_config.env;
    const registryVars = server.packages[0].environmentVariables;
    assert.deepEqual(Object.keys(env).sort(), registryVars.map((v) => v.name).sort());
    const used = Object.values(env).map((value) => /^\$\{user_config\.([a-z_]+)\}$/.exec(value)?.[1]);
    assert.deepEqual([...used].sort(), Object.keys(manifest.user_config).sort(), 'each setting feeds one variable, and each variable comes from one setting');
    for (const variable of registryVars) {
        const setting = manifest.user_config[/\.([a-z_]+)\}$/.exec(env[variable.name])[1]];
        assert.equal(setting.default, variable.default, `${variable.name} default`);
        assert.equal(Boolean(setting.sensitive), Boolean(variable.isSecret), `${variable.name} is secret in both`);
        assert.equal(Boolean(setting.required), Boolean(variable.isRequired), `${variable.name} is optional in both`);
    }
});
