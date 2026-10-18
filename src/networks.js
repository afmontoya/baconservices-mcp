// The two payment networks this package will ever sign on, and what Bacon looks like on each.
//
// Chain facts are pinned here, not read from the server: a 402 that names a different chain,
// asset or EIP-712 domain is refused before anything is signed. USDC addresses: Circle's
// published contracts (the same ones Bacon's App\Support\AgentCommerce\Networks pins).

export const PRODUCTION_API_URL = 'https://baconservices.com';

export const NETWORKS = {
    base: {
        key: 'base',
        id: 'eip155:8453',
        chainId: 8453,
        label: 'Base',
        testnet: false,
        usdc: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', name: 'USD Coin', version: '2' },
        rpcUrl: 'https://mainnet.base.org',
        explorer: 'https://basescan.org/tx/',
        // Bacon's receiving wallet on Base (production 402, checked 2026-10-17). A 402 asking to pay
        // anyone else is refused; a new address means a new release of this package.
        payTo: '0xdec990f28082da7efc9c50df26adba40b66cc4d6',
    },
    'base-sepolia': {
        key: 'base-sepolia',
        id: 'eip155:84532',
        chainId: 84532,
        label: 'Base Sepolia (testnet)',
        testnet: true,
        usdc: { address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', name: 'USDC', version: '2' },
        rpcUrl: 'https://sepolia.base.org',
        explorer: 'https://sepolia.basescan.org/tx/',
        // A test copy of Bacon has its own receiving wallet: set BACON_PAY_TO.
        payTo: null,
    },
};

export function sameAddress(a, b) {
    return typeof a === 'string' && typeof b === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a) && a.toLowerCase() === b.toLowerCase();
}
