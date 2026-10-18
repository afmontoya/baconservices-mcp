// The live catalog: what Bacon sells right now, matched against the contracts this package knows.

import { CONTRACTS, checkEntry, contractForEntry, contractId } from './contracts.js';
import { formatUsdc } from './money.js';

export const CATALOG_PATH = '/api/agent-commerce/v1/capabilities';

export function endpointFor(apiUrl, id) {
    return `${apiUrl}${CATALOG_PATH}/${id}/execute`;
}

/**
 * Fetches the catalog and decides, per entry, whether it is executable here.
 * Throws with a plain message when the catalog cannot be read or is not on the configured network.
 */
export async function fetchCatalog(config, fetchImpl) {
    let response;
    try {
        response = await fetchImpl(`${config.apiUrl}${CATALOG_PATH}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
    } catch (error) {
        throw new Error(`Could not reach Bacon's service catalog at ${config.apiUrl}${CATALOG_PATH} (${error.name === 'TimeoutError' ? 'timed out' : error.message}).`);
    }
    if (response.status === 404) {
        throw new Error('Bacon is not selling services to agents right now (the catalog is closed).');
    }
    let data = null;
    try {
        data = await response.json();
    } catch {
        // checked below
    }
    if (!response.ok || !data || !Array.isArray(data.capabilities)) {
        throw new Error(`Bacon's service catalog answered ${response.status} without a capability list.`);
    }
    if (data.protocol?.name !== 'x402' || data.protocol?.version !== 2 || data.protocol?.scheme !== 'exact') {
        throw new Error('Bacon\'s catalog does not describe x402 v2 "exact" payments, which is all this package can make.');
    }
    if (data.network?.id !== config.network.id || data.network?.testnet !== config.network.testnet) {
        throw new Error(`Bacon at ${config.apiUrl} sells on ${data.network?.id ?? 'an unknown network'}${data.network?.testnet ? ' (testnet)' : ''}, but this package is set to ${config.network.id} (${config.network.label}). Nothing can be paid until they match.`);
    }

    const services = data.capabilities.map((entry) => {
        const contract = contractForEntry(entry);
        const reasons = checkEntry(entry, contract, { endpoint: endpointFor(config.apiUrl, entry.id), usdc: config.network.usdc.address, catalogVersion: data.contract_version });
        return {
            id: entry.id,
            name: entry.name,
            description: entry.description,
            contract: contractId(entry.id, entry.version),
            tool: contract?.tool ?? null,
            executable: reasons.length === 0,
            not_executable_because: reasons,
            price: entry.price && /^\d+$/.test(entry.price.amount ?? '') ? { usdc: formatUsdc(entry.price.amount), atomic: entry.price.amount } : null,
            execution: entry.execution ?? null,
            output: entry.output ?? null,
            limits: entry.limits ?? null,
            entry,
            contractDef: contract,
        };
    });

    return { network: data.network, contractVersion: data.contract_version ?? null, services };
}

/** The tools a catalog makes executable, in the package's own order. */
export function executableTools(catalog) {
    if (!catalog) {
        return [];
    }
    return CONTRACTS.map((c) => catalog.services.find((s) => s.tool === c.tool && s.executable)).filter(Boolean);
}
