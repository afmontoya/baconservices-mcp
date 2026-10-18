// The real entry point over stdio, as an MCP host runs it: a child process speaking JSON-RPC on
// stdout, talking HTTP to a fake test-money Bacon, reading its balance through viem's RPC client.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { BUYER, KEY, imageFile, tempDir } from './helpers.js';
import { createFakeBacon, WEBP } from './fake-bacon.js';

const BIN = fileURLToPath(new URL('../bin/baconservices-mcp.js', import.meta.url));

const freePort = () => new Promise((resolve) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
        const { port } = probe.address();
        probe.close(() => resolve(port));
    });
});

test('the stdio server lists, quotes and buys against a test copy of Bacon, and never prints the key', async () => {
    const port = await freePort();
    const apiUrl = `http://127.0.0.1:${port}`;
    const payTo = '0x209693Bc6afc0C5328bA36FaF03C514EF312287C';
    const fake = createFakeBacon({ networkKey: 'base-sepolia', apiUrl, payTo });
    fake.balances.set(BUYER.toLowerCase(), 1_000_000n);
    await fake.listen(port);

    const dir = tempDir();
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [BIN],
        env: {
            PATH: process.env.PATH ?? '',
            SYSTEMROOT: process.env.SYSTEMROOT ?? '',
            BACON_WALLET_PRIVATE_KEY: KEY,
            BACON_NETWORK: 'base-sepolia',
            BACON_API_URL: apiUrl,
            BACON_PAY_TO: payTo,
            BACON_RPC_URL: `${apiUrl}/rpc`,
            BACON_LEDGER_DIR: join(dir, 'ledger'),
        },
        stderr: 'pipe',
    });
    let stderr = '';
    transport.stderr?.on('data', (chunk) => {
        stderr += chunk;
    });
    const client = new Client({ name: 'stdio-test', version: '1.0.0' });
    try {
        await client.connect(transport);
        assert.equal(client.getServerVersion().name, 'baconservices-mcp');
        const tools = (await client.listTools()).tools.map((t) => t.name);
        assert.deepEqual(tools, ['list_services', 'quote', 'wallet_status', 'remove_background', 'optimize_image']);

        const quote = JSON.parse((await client.callTool({ name: 'quote', arguments: { service: 'optimize_image' } })).content[0].text);
        assert.equal(quote.price_usdc, '0.01');
        assert.equal(quote.sufficient_balance, 'yes', 'balance read over JSON-RPC by viem');

        const out = join(dir, 'out.webp');
        const bought = await client.callTool({ name: 'optimize_image', arguments: { image_path: imageFile(dir), save_to: out } });
        const result = JSON.parse(bought.content[0].text);
        assert.equal(bought.isError, undefined, bought.content[0].text);
        assert.equal(result.paid_usdc, '0.01');
        assert.equal(result.testnet, true);
        assert.deepEqual(readFileSync(out), WEBP);
        assert.equal(fake.settled.length, 1);
        assert.equal(JSON.parse(readFileSync(join(dir, 'ledger', 'spend-ledger.json'), 'utf8')).entries[0].status, 'spent');
        assert.equal(readFileSync(join(dir, 'ledger', 'spend-ledger.json'), 'utf8').toLowerCase().includes(KEY.slice(2).toLowerCase()), false, 'no key in the ledger');
    } finally {
        await client.close();
        await fake.close();
    }
    assert.equal(stderr.toLowerCase().includes(KEY.slice(2).toLowerCase()), false);
});
