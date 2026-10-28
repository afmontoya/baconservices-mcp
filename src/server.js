// The Bacon MCP server: free discovery tools, and one paid tool per capability whose contract
// this package understands and whose live catalog entry matches it.
//
// A thin commerce client: Bacon does the image work; this package only discovers, enforces the
// buyer's spending policy, signs with the buyer's own key, and hands back the result.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { executableTools, fetchCatalog } from './catalog.js';
import { CONTRACTS } from './contracts.js';
import { loadConfig } from './config.js';
import { Ledger } from './ledger.js';
import { formatUsdc } from './money.js';
import { Purchaser, Refusal } from './payment.js';
import { balanceReader, loadWallet, redact } from './wallet.js';

export const VERSION = '0.2.0';
const CATALOG_TTL_MS = 5 * 60 * 1000;

const FREE_TOOLS = [
    {
        name: 'list_services',
        description: 'Lists what Bacon Services sells to agents right now, from its live catalog: each service\'s price in USDC, network, output, input limits, and whether this installed package can run it (and as which tool). Free.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
        name: 'quote',
        description: 'Gets Bacon\'s current price for one service without paying, and says whether your spending limits and wallet allow it. Free; nothing is signed.',
        inputSchema: {
            type: 'object',
            properties: { service: { type: 'string', description: 'A tool name (e.g. remove_background) or service id (e.g. remove-background).' } },
            required: ['service'],
            additionalProperties: false,
        },
    },
    {
        name: 'wallet_status',
        description: 'Shows the payment network, whether a wallet is configured, your spending limits and what is left of them, and whether the wallet can afford each service (yes/no). Free. The exact balance is shown only if the buyer enabled BACON_DISCLOSE_BALANCE.',
        inputSchema: {
            type: 'object',
            properties: { service: { type: 'string', description: 'Optional: only check this service.' } },
            additionalProperties: false,
        },
    },
];

/**
 * @param {object} deps env, fetch, readBalance (usdc, owner) → atomic balance, now, home: injectable for tests.
 */
export function createBaconServer({ env = process.env, fetch = globalThis.fetch, readBalance = null, now = () => Date.now(), home } = {}) {
    const config = loadConfig(env, home ? { home } : {});
    const wallet = loadWallet(env);
    const secrets = wallet.secrets;
    const ledger = new Ledger(config.ledgerDir, { now });

    const server = new Server(
        { name: 'baconservices-mcp', title: 'Bacon Services', version: VERSION },
        {
            capabilities: { tools: { listChanged: true } },
            instructions: 'Bacon Services sells image operations to agents per call, paid in USDC over x402 from the buyer\'s own wallet. Call list_services or quote first; paid tools state their price, and the buyer\'s per-call, per-session and daily limits are enforced locally before anything is signed.',
        },
    );

    // Only a valid configuration can pay; with problems, every tool explains them instead.
    const purchaser = config.problems.length === 0
        ? new Purchaser({ config, account: wallet.account, fetch, readBalance: readBalance ?? balanceReader(config.rpcUrl), ledger, confirm: (message) => confirm(message) })
        : null;

    let cached = null; // { at, catalog } or { at, error }
    let announced = null; // tool names last given to the client

    async function catalog({ fresh = false } = {}) {
        if (config.problems.length) {
            throw new Refusal(`This MCP server is not configured correctly: ${config.problems.join(' ')}`);
        }
        if (!fresh && cached && now() - cached.at < CATALOG_TTL_MS) {
            if (cached.error) {
                throw new Refusal(cached.error);
            }
            return cached.catalog;
        }
        try {
            const result = await fetchCatalog(config, fetch);
            cached = { at: now(), catalog: result };
        } catch (error) {
            cached = { at: now(), error: error.message };
        }
        await announceIfChanged();
        if (cached.error) {
            throw new Refusal(cached.error);
        }
        return cached.catalog;
    }

    function toolNames() {
        return [...FREE_TOOLS.map((t) => t.name), ...executableTools(cached?.catalog).map((s) => s.tool)];
    }

    async function announceIfChanged() {
        const names = toolNames().join(',');
        if (announced !== null && names !== announced) {
            announced = names;
            await server.sendToolListChanged().catch(() => {});
        }
    }

    async function confirm(message) {
        if (config.confirm === 'never') {
            return true;
        }
        const canAsk = Boolean(server.getClientCapabilities()?.elicitation?.form);
        if (!canAsk) {
            if (config.confirm === 'always') {
                throw new Refusal('Not paying: BACON_CONFIRM=always, but this MCP host cannot ask you to confirm payments. Nothing was signed.');
            }
            return true;
        }
        let answer;
        try {
            answer = await server.elicitInput({
                message,
                requestedSchema: { type: 'object', properties: { pay: { type: 'boolean', title: 'Pay', description: message } }, required: ['pay'] },
            });
        } catch (error) {
            throw new Refusal(`Not paying: the confirmation could not be asked (${error.message}). Nothing was signed.`);
        }
        return answer.action === 'accept' && answer.content?.pay === true;
    }

    function paidTool(service) {
        const contract = service.contractDef;
        const limits = service.entry.limits;
        const network = config.network;
        const options = Object.fromEntries(Object.entries(contract.options).map(([name, spec]) => [name, { ...spec }]));
        const price = `Costs ${service.price.usdc} USDC per call${network.testnet ? ' (test USDC)' : ' (real money)'} on ${network.label}, paid from the buyer's wallet over x402 after the buyer's spending limits are checked.`;
        const output = contract.output.kind === 'json'
            ? 'Output: JSON, returned in the tool result.'
            : `Output: ${contract.output.mime}, as a download link (and a file with save_to).`;
        let input;
        let source;
        if (contract.input === 'url') {
            input = 'Give url: one public web page (http or https, standard ports).';
            source = { url: { type: 'string', description: 'A public web page, usually the homepage.', maxLength: service.entry.input.properties.url.maxLength ?? 2048 } };
        } else {
            const formats = limits.formats.map((f) => f.replace('image/', '').toUpperCase()).join(', ');
            input = `Input: ${formats}, up to ${Math.floor(limits.max_bytes / 1048576)} MB${limits.max_dimension ? `, at most ${limits.max_dimension} px` : ''}. Give exactly one of image_url or image_path.`;
            source = {
                image_url: { type: 'string', description: 'A public https URL of the image.' },
                image_path: { type: 'string', description: 'A local image file to send (read by this server, sent base64).' },
            };
        }
        return {
            name: service.tool,
            title: contract.title,
            description: `${contract.summary} ${price} ${input} ${output}`,
            inputSchema: {
                type: 'object',
                properties: {
                    ...source,
                    ...options,
                    save_to: { type: 'string', description: `Optional local file path to save the result to (${contract.output.kind === 'json' ? 'JSON' : contract.output.mime}).` },
                    overwrite: { type: 'boolean', description: 'Replace save_to if it exists. Default false.' },
                    max_price_usdc: { type: ['string', 'number'], description: 'Optional: refuse if Bacon asks more than this, in USDC.' },
                    allow_repeat: { type: 'boolean', description: 'Buy again even if the same request was bought in the last 10 minutes. Default false: the earlier result is returned and nothing is charged.' },
                },
                additionalProperties: false,
            },
            annotations: { title: contract.title, readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
        };
    }

    server.setRequestHandler(ListToolsRequestSchema, async () => {
        try {
            await catalog();
        } catch {
            // Discovery tools still work and explain what is wrong.
        }
        const paid = executableTools(cached?.catalog).map(paidTool);
        announced = toolNames().join(',');
        return { tools: [...FREE_TOOLS, ...paid] };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args = {} } = request.params;
        try {
            const result = await call(name, args);
            return { content: [{ type: 'text', text: redact(JSON.stringify(result, null, 2), secrets) }] };
        } catch (error) {
            const message = error instanceof Refusal ? error.message : `Unexpected error: ${error.message}`;
            const payload = { ok: false, error: message, charged: error instanceof Refusal ? error.charged : 'unknown', ...(error.details ?? {}) };
            return { isError: true, content: [{ type: 'text', text: redact(JSON.stringify(payload, null, 2), secrets) }] };
        }
    });

    async function call(name, args) {
        if (name === 'list_services') {
            return listServices();
        }
        if (name === 'wallet_status') {
            return walletStatus(args.service);
        }
        if (name === 'quote') {
            return quote(args.service);
        }
        const contract = CONTRACTS.find((c) => c.tool === name);
        if (!contract) {
            throw new Refusal(`Unknown tool ${name}.`);
        }
        if (!wallet.account) {
            throw new Refusal(wallet.problem);
        }
        // The price and contract are read fresh before every purchase.
        const live = await catalog({ fresh: true });
        const service = live.services.find((s) => s.tool === name);
        if (!service) {
            throw new Refusal(`${name} is not for sale right now.`);
        }
        if (!service.executable) {
            throw new Refusal(`${name} cannot be run by this version of the package: ${service.not_executable_because.join('; ')}.`);
        }
        return purchaser.buy(service, args);
    }

    async function listServices() {
        const live = await catalog({ fresh: true });
        return {
            bacon: config.apiUrl,
            network: { id: config.network.id, label: config.network.label, testnet: config.network.testnet },
            services: live.services.map((s) => ({
                id: s.id,
                name: s.name,
                description: s.description,
                contract: s.contract,
                price_usdc: s.price?.usdc ?? null,
                execution: s.execution,
                output: s.output,
                limits: s.limits,
                tool: s.executable ? s.tool : null,
                executable: s.executable,
                ...(s.executable ? {} : { not_executable_because: s.not_executable_because }),
            })),
        };
    }

    function findService(live, key) {
        const service = live.services.find((s) => s.tool === key || s.id === key);
        if (!service) {
            throw new Refusal(`No service "${key}". Call list_services to see what is for sale.`);
        }
        return service;
    }

    async function quote(key) {
        const live = await catalog({ fresh: true });
        const service = findService(live, String(key ?? ''));
        if (!service.executable) {
            return { service: service.id, executable: false, not_executable_because: service.not_executable_because, catalog_price_usdc: service.price?.usdc ?? null };
        }
        const { amount, accepted } = await purchaser.quote(service);
        const problems = await purchaser.limitProblems(amount);
        let sufficient = null;
        if (wallet.account) {
            try {
                sufficient = (await purchaser.hasFunds(amount)) ? 'yes' : 'no';
            } catch {
                sufficient = 'unknown (the balance could not be read)';
            }
        }
        return {
            service: service.tool,
            price_usdc: formatUsdc(amount),
            network: config.network.id,
            testnet: config.network.testnet,
            pay_to: accepted.payTo,
            pay_to_verified: true,
            within_limits: problems.length === 0,
            ...(problems.length ? { limit_problems: problems } : {}),
            wallet_configured: Boolean(wallet.account),
            sufficient_balance: sufficient,
            confirmation: confirmationMode(),
        };
    }

    async function walletStatus(only) {
        const status = {
            network: config.network ? { id: config.network.id, label: config.network.label, testnet: config.network.testnet } : null,
            bacon: config.apiUrl,
            wallet_configured: Boolean(wallet.account),
            ...(wallet.problem && (env.BACON_WALLET_PRIVATE_KEY || env.BACON_WALLET_KEY_FILE) ? { wallet_problem: wallet.problem } : {}),
            ...(config.problems.length ? { configuration_problems: config.problems } : {}),
            confirmation: confirmationMode(),
        };
        if (config.problems.length) {
            return status;
        }
        const day = await ledger.spentLastDay(config.network.id);
        const { perCall, perSession, perDay } = config.limits;
        status.limits_usdc = { per_call: formatUsdc(perCall), per_session: formatUsdc(perSession), per_24_hours: formatUsdc(perDay) };
        status.spent_usdc = { this_session: formatUsdc(purchaser.sessionCommitted), last_24_hours: formatUsdc(day) };
        status.remaining_usdc = {
            this_session: formatUsdc(perSession > purchaser.sessionCommitted ? perSession - purchaser.sessionCommitted : 0n),
            last_24_hours: formatUsdc(perDay > day ? perDay - day : 0n),
        };
        if (!wallet.account) {
            return status;
        }
        let balance = null;
        try {
            balance = await purchaser.balance();
        } catch {
            status.balance_check = 'The wallet balance could not be read; purchases are refused until it can.';
        }
        if (balance !== null) {
            let services = [];
            try {
                services = executableTools(await catalog());
            } catch (error) {
                status.catalog_problem = error.message;
            }
            status.can_afford = Object.fromEntries(services.filter((s) => !only || s.tool === only || s.id === only)
                .map((s) => [s.tool, balance >= BigInt(s.entry.price.amount) ? 'yes' : 'no']));
            if (config.discloseBalance) {
                status.address = wallet.account.address;
                status.usdc_balance = formatUsdc(balance);
            }
        }
        return status;
    }

    function confirmationMode() {
        const canAsk = Boolean(server.getClientCapabilities()?.elicitation?.form);
        return {
            mode: config.confirm,
            host_can_ask: canAsk,
            note: config.confirm === 'never' ? 'Payments are not confirmed interactively; the spending limits still apply.'
                : canAsk ? 'You are asked to approve each payment.'
                    : config.confirm === 'always' ? 'This host cannot ask, so paid tools refuse (BACON_CONFIRM=always).'
                        : 'This host cannot ask, so payments within the spending limits go ahead.',
        };
    }

    return { server, config, ledger, purchaser };
}
