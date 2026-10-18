// Configuration from the environment, with the network guard.
//
// Real money (Base) talks to https://baconservices.com and nothing else. Test money (Base
// Sepolia) talks to a test copy of Bacon and never to production. A mismatch is a configuration
// problem: nothing is fetched and nothing can be paid until it is fixed.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseUsdc } from './money.js';
import { NETWORKS, PRODUCTION_API_URL } from './networks.js';

export const DEFAULT_LIMITS = { perCall: '0.50', perSession: '1.00', perDay: '5.00' };
export const CONFIRM_MODES = ['auto', 'always', 'never'];

const PRODUCTION_HOSTS = ['baconservices.com', 'www.baconservices.com'];
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

/**
 * @returns {{ problems: string[], network: object|null, apiUrl: string|null, limits: object, confirm: string,
 *            ledgerDir: string, rpcUrl: string|null, payTo: string|null, discloseBalance: boolean }}
 */
export function loadConfig(env, { home = homedir() } = {}) {
    const problems = [];
    const read = (name) => (env[name] ?? '').trim();

    const networkKey = read('BACON_NETWORK') || 'base';
    const network = NETWORKS[networkKey] ?? null;
    if (!network) {
        problems.push(`BACON_NETWORK must be "base" (real USDC) or "base-sepolia" (test USDC), not "${networkKey}".`);
    }

    let apiUrl = null;
    const rawApi = read('BACON_API_URL').replace(/\/+$/, '');
    if (network) {
        if (!network.testnet) {
            apiUrl = PRODUCTION_API_URL;
            if (rawApi && rawApi !== PRODUCTION_API_URL) {
                problems.push(`BACON_NETWORK=base pays real money and only talks to ${PRODUCTION_API_URL}; BACON_API_URL is "${rawApi}". For a test copy of Bacon use BACON_NETWORK=base-sepolia.`);
            }
        } else if (!rawApi) {
            problems.push('BACON_NETWORK=base-sepolia needs BACON_API_URL: the address of a test copy of Bacon (production sells for real money only).');
        } else {
            let url = null;
            try {
                url = new URL(rawApi);
            } catch {
                problems.push(`BACON_API_URL "${rawApi}" is not a URL.`);
            }
            if (url) {
                if (PRODUCTION_HOSTS.includes(url.hostname)) {
                    problems.push(`BACON_NETWORK=base-sepolia cannot use production (${url.hostname}): production sells for real money only. Use BACON_NETWORK=base, or point BACON_API_URL at a test copy of Bacon.`);
                } else if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOCAL_HOSTS.includes(url.hostname))) {
                    problems.push('BACON_API_URL must be https (plain http only for localhost).');
                } else {
                    apiUrl = url.origin;
                }
            }
        }
    }

    let payTo = network?.payTo ?? null;
    const rawPayTo = read('BACON_PAY_TO');
    if (network?.testnet) {
        if (!/^0x[0-9a-fA-F]{40}$/.test(rawPayTo)) {
            problems.push('BACON_NETWORK=base-sepolia needs BACON_PAY_TO: the receiving address of the test copy of Bacon, so payments to anyone else are refused.');
        } else {
            payTo = rawPayTo;
        }
    } else if (network && rawPayTo && rawPayTo.toLowerCase() !== network.payTo) {
        problems.push('BACON_PAY_TO cannot change Bacon\'s receiving address on Base; leave it unset.');
    }

    const limits = {};
    for (const [key, name] of [['perCall', 'BACON_MAX_PER_CALL'], ['perSession', 'BACON_MAX_PER_SESSION'], ['perDay', 'BACON_MAX_PER_DAY']]) {
        try {
            limits[key] = parseUsdc(read(name) || DEFAULT_LIMITS[key], name);
            if (limits[key] <= 0n) {
                problems.push(`${name} must be more than 0.`);
            }
        } catch (error) {
            problems.push(error.message);
        }
    }

    const confirm = (read('BACON_CONFIRM') || 'auto').toLowerCase();
    if (!CONFIRM_MODES.includes(confirm)) {
        problems.push(`BACON_CONFIRM must be auto, always or never (got "${confirm}").`);
    }

    const rpcUrl = read('BACON_RPC_URL') || network?.rpcUrl || null;

    return {
        problems,
        network,
        apiUrl,
        payTo,
        limits,
        confirm,
        rpcUrl,
        ledgerDir: read('BACON_LEDGER_DIR') || join(home, '.baconservices-mcp'),
        discloseBalance: /^(1|true|yes)$/i.test(read('BACON_DISCLOSE_BALANCE')),
    };
}
