import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createBaconServer } from '../src/server.js';
import { createFakeBacon, PNG } from './fake-bacon.js';

export const KEY = generatePrivateKey();
export const BUYER = privateKeyToAccount(KEY).address;

export function tempDir() {
    return mkdtempSync(join(tmpdir(), 'bacon-mcp-'));
}

/** A PNG on disk whose bytes differ per `tag`, so each is a different request. */
export function imageFile(dir, tag = 'a') {
    const path = join(dir, `in-${tag}.png`);
    writeFileSync(path, Buffer.concat([PNG, Buffer.from(tag)]));
    return path;
}

/**
 * An MCP client connected in memory to a Bacon MCP server that talks to a fake Bacon.
 * `elicit`: when given, the client declares elicitation and answers with it.
 */
export async function connect({ env = {}, fake = createFakeBacon(), ledgerDir = tempDir(), now, elicit, balance = 10_000_000n } = {}) {
    fake.balances.set(BUYER.toLowerCase(), balance);
    const created = createBaconServer({
        env: { BACON_WALLET_PRIVATE_KEY: KEY, BACON_LEDGER_DIR: ledgerDir, ...env },
        fetch: fake.fetch,
        readBalance: fake.balanceOf,
        ...(now ? { now } : {}),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1.0.0' }, { capabilities: elicit ? { elicitation: { form: {} } } : {} });
    const asked = [];
    if (elicit) {
        client.setRequestHandler(ElicitRequestSchema, async (request) => {
            asked.push(request.params.message);
            return elicit(request.params);
        });
    }
    await created.server.connect(serverTransport);
    await client.connect(clientTransport);

    const call = async (name, args = {}) => {
        const result = await client.callTool({ name, arguments: args });
        return { error: Boolean(result.isError), data: JSON.parse(result.content[0].text), text: result.content[0].text };
    };
    return { client, fake, ledgerDir, call, asked, ...created };
}
