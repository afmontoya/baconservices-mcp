// The buyer's signer, from their own machine only.
//
// The private key comes from BACON_WALLET_PRIVATE_KEY or from a file named by
// BACON_WALLET_KEY_FILE (so it need not sit in an MCP host's config file). It is never a tool
// argument, never sent anywhere (only signatures leave this process), and never printed: every
// message this package produces passes through redact(), which removes it in any spelling.

import { readFileSync } from 'node:fs';
import { createPublicClient, http, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const ERC20 = parseAbi(['function balanceOf(address owner) view returns (uint256)']);

/** @returns {{ account: object|null, problem: string|null, secrets: string[] }} */
export function loadWallet(env) {
    const inline = env.BACON_WALLET_PRIVATE_KEY ?? '';
    const file = (env.BACON_WALLET_KEY_FILE ?? '').trim();
    if (inline.trim() && file) {
        return { account: null, problem: 'Set only one of BACON_WALLET_PRIVATE_KEY or BACON_WALLET_KEY_FILE.', secrets: secretsOf(inline) };
    }
    let raw = inline;
    if (file) {
        try {
            raw = readFileSync(file, 'utf8');
        } catch {
            return { account: null, problem: `BACON_WALLET_KEY_FILE could not be read (${file}).`, secrets: [] };
        }
    }
    const cleaned = raw.replace(/[\s"']/g, '');
    if (!cleaned) {
        return { account: null, problem: 'No wallet is configured: set BACON_WALLET_PRIVATE_KEY or BACON_WALLET_KEY_FILE to pay for services.', secrets: [] };
    }
    const key = cleaned.startsWith('0x') ? cleaned : `0x${cleaned}`;
    const secrets = secretsOf(cleaned);
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
        // Says what is wrong with it without repeating any of it.
        return { account: null, problem: `The wallet key is not a private key: it has ${key.length - 2} characters after 0x, a private key has exactly 64 hex characters.`, secrets };
    }
    return { account: privateKeyToAccount(key), problem: null, secrets };
}

function secretsOf(raw) {
    const bare = raw.replace(/[\s"']/g, '').replace(/^0x/i, '');
    return bare.length >= 8 ? [bare] : [];
}

/** Removes every secret from a message, whatever its case and with or without 0x. */
export function redact(text, secrets) {
    let out = String(text);
    for (const secret of secrets) {
        out = out.replace(new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '[redacted]');
    }
    return out;
}

/** The wallet's USDC balance in atomic units, read from the network's RPC. Throws when it cannot be read. */
export function balanceReader(rpcUrl) {
    const client = createPublicClient({ transport: http(rpcUrl, { timeout: 15_000, retryCount: 1 }) });
    return (usdcAddress, owner) => client.readContract({ address: usdcAddress, abi: ERC20, functionName: 'balanceOf', args: [owner] });
}
