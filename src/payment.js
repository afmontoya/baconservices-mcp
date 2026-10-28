// One purchase, start to finish: the payment state machine.
//
//   input checked → quoted (402 from Bacon) → requirement verified → limits checked
//   → funds checked → confirmed → RESERVED in the ledger → signed → sent
//   → SPENT (delivered) | RELEASED (Bacon refused before taking money) | UNCERTAIN (unknown: counts)
//
// Nothing is signed until every check before it has passed; any check that cannot be completed
// refuses (fails closed). One purchase signs exactly one payment, with a fresh EIP-3009 nonce, for
// exactly the quoted request body. A lost connection is retried once with the SAME signed payment
// and the SAME body, which Bacon answers idempotently; a new signature is never made on retry.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { x402Client, x402HTTPClient } from '@x402/core/client';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { endpointFor } from './catalog.js';
import { contractId } from './contracts.js';
import { atomicFromWire, formatUsdc, parseUsdc } from './money.js';
import { sameAddress } from './networks.js';

/** A purchase that stopped. `charged`: false (nothing taken), 'unknown', or true. */
export class Refusal extends Error {
    constructor(message, { charged = false, details = {} } = {}) {
        super(message);
        this.charged = charged;
        this.details = details;
    }
}

// Bacon's answers that mean the payment was not used (its PaidExecution refuses or fails before settling).
const NOT_CHARGED_CODES = new Set(['execution_failed', 'not_accepted', 'busy', 'invalid_input', 'capability_unavailable', 'unsupported_capability']);

const QUOTE_TIMEOUT_MS = 60_000;
// A paid call waits for Bacon's own declared budget (limits.max_seconds) plus a margin, or this.
const PAY_TIMEOUT_MS = 120_000;
const PAY_MARGIN_MS = 30_000;
// Whatever a capability declares, a JSON result larger than this is never handed to the model.
export const HARD_MAX_RESULT_BYTES = 256 * 1024;

const ajv = new Ajv2020({ strict: false, allErrors: false });
addFormats(ajv);
const validators = new WeakMap();

/** How long to wait for a paid call to this catalog entry. */
export function payTimeoutMs(entry) {
    const seconds = entry?.limits?.max_seconds;
    return Number.isInteger(seconds) && seconds > 0 ? seconds * 1000 + PAY_MARGIN_MS : PAY_TIMEOUT_MS;
}

export class Purchaser {
    constructor({ config, account, fetch, readBalance, ledger, confirm }) {
        this.config = config;
        this.account = account;
        this.fetch = fetch;
        this.readBalance = readBalance;
        this.ledger = ledger;
        this.confirm = confirm;
        // This process's total (reserved, spent or uncertain): the per-session ceiling.
        this.sessionCommitted = 0n;
        if (account) {
            const client = new x402Client()
                .register(config.network.id, new ExactEvmScheme(account))
                // The library's own lock, at the same per-call ceiling: a second check of the signed amount.
                .setSpendControls({ maxAmountPerPayment: `$${formatUsdc(config.limits.perCall)}` });
            this.http = new x402HTTPClient(client);
        } else {
            this.http = new x402HTTPClient(new x402Client());
        }
    }

    /** Asks Bacon for the authoritative price (an empty request: nothing is recorded or charged) and verifies it. */
    async quote(service) {
        const endpoint = endpointFor(this.config.apiUrl, service.id);
        const response = await this.#post(endpoint, '{}', {}, QUOTE_TIMEOUT_MS);
        const required = await this.#requirementFrom(response, endpoint);
        return this.verifyRequirement(required, service, endpoint);
    }

    /**
     * The 402's requirement, checked against everything this package pins: x402 v2, this exact
     * endpoint, scheme "exact" on the configured network, that network's USDC and EIP-712 domain,
     * Bacon's receiving address, and the catalog's price. Returns the requirement narrowed to the
     * one accepted option, so the library cannot pick another.
     */
    verifyRequirement(required, service, endpoint) {
        const { network, payTo } = this.config;
        const refuse = (why) => {
            throw new Refusal(`Not paying: ${why}. Nothing was signed.`);
        };
        if (required?.x402Version !== 2) {
            refuse('Bacon did not answer with an x402 v2 payment requirement');
        }
        if (required.resource?.url !== endpoint) {
            refuse(`the payment requirement is for ${required.resource?.url ?? 'an unnamed resource'}, not ${endpoint}`);
        }
        const accepted = (required.accepts ?? []).find((a) => a.scheme === 'exact' && a.network === network.id);
        if (!accepted) {
            refuse(`Bacon did not offer an "exact" payment on ${network.label} (${network.id})`);
        }
        if (!sameAddress(accepted.asset, network.usdc.address) || accepted.extra?.name !== network.usdc.name || accepted.extra?.version !== network.usdc.version) {
            refuse(`the asset is not ${network.label} USDC`);
        }
        if (!sameAddress(accepted.payTo, payTo)) {
            refuse(`the payment would go to ${accepted.payTo}, which is not Bacon's receiving address ${payTo}`);
        }
        const amount = atomicFromWire(accepted.amount);
        if (amount === null || amount <= 0n) {
            refuse('the price is not a positive amount');
        }
        if (amount !== BigInt(service.entry.price.amount)) {
            refuse(`Bacon asks ${formatUsdc(amount)} USDC but its catalog lists ${formatUsdc(service.entry.price.amount)} USDC for ${service.tool}`);
        }
        if (!Number.isInteger(accepted.maxTimeoutSeconds) || accepted.maxTimeoutSeconds < 1 || accepted.maxTimeoutSeconds > 3600) {
            refuse('the payment window is not between 1 second and 1 hour');
        }
        return { required: { ...required, accepts: [accepted] }, accepted, amount };
    }

    /** The limits a price must fit, as a list of reasons it does not (empty when it fits). */
    async limitProblems(amount, maxPrice = null) {
        const { limits, network } = this.config;
        const problems = [];
        if (amount > limits.perCall) {
            problems.push(`${formatUsdc(amount)} USDC is above your per-call limit of ${formatUsdc(limits.perCall)} USDC (BACON_MAX_PER_CALL)`);
        }
        if (maxPrice !== null && amount > maxPrice) {
            problems.push(`${formatUsdc(amount)} USDC is above the max_price_usdc of ${formatUsdc(maxPrice)} given for this call`);
        }
        if (this.sessionCommitted + amount > limits.perSession) {
            problems.push(`this session has used ${formatUsdc(this.sessionCommitted)} of its ${formatUsdc(limits.perSession)} USDC limit (BACON_MAX_PER_SESSION)`);
        }
        const day = await this.ledger.spentLastDay(network.id);
        if (day + amount > limits.perDay) {
            problems.push(`the last 24 hours have used ${formatUsdc(day)} of your ${formatUsdc(limits.perDay)} USDC daily limit (BACON_MAX_PER_DAY)`);
        }
        return problems;
    }

    /** Whether the wallet holds at least `amount`. Throws a Refusal when the balance cannot be read. */
    async hasFunds(amount) {
        const balance = await this.balance();
        return balance >= amount;
    }

    async balance() {
        try {
            return BigInt(await this.readBalance(this.config.network.usdc.address, this.account.address));
        } catch {
            throw new Refusal(`Not paying: the wallet's USDC balance on ${this.config.network.label} could not be checked (RPC ${this.config.rpcUrl} did not answer; set BACON_RPC_URL to another). Nothing was signed.`);
        }
    }

    /** Buys one run of `service` with the tool arguments `args`. */
    async buy(service, args) {
        const { network, apiUrl } = this.config;
        const contract = service.contractDef;
        const endpoint = endpointFor(apiUrl, service.id);

        // 1. Input, options, destination and the caller's price ceiling: all before any request.
        const image = contract.input === 'url' ? prepareUrl(args, service.entry.input) : prepareImage(args, service.entry.limits);
        const options = prepareOptions(args, contract);
        const saveTo = prepareSaveTo(args);
        let maxPrice = null;
        if (args.max_price_usdc !== undefined && args.max_price_usdc !== null) {
            try {
                maxPrice = parseUsdc(String(args.max_price_usdc), 'max_price_usdc');
            } catch (error) {
                throw new Refusal(error.message);
            }
        }
        const body = JSON.stringify({ ...image.body, ...options });
        const maxRequest = service.entry.limits.max_request_bytes;
        if (Number.isInteger(maxRequest) && Buffer.byteLength(body) > maxRequest) {
            throw new Refusal(`The request would be ${Buffer.byteLength(body)} bytes; Bacon takes at most ${maxRequest} for ${service.tool}. Nothing was sent.`);
        }
        const fingerprint = sha256(JSON.stringify({ contract: contractId(service.id, contract.version), image: image.identity, options }));

        // 2. Bought this exact thing a moment ago? Hand that back instead of paying again.
        if (!args.allow_repeat) {
            const earlier = await this.ledger.recent(network.id, fingerprint);
            if (earlier) {
                return this.#earlier(earlier, saveTo);
            }
        }

        // 3. Bacon's authoritative price for this exact request, verified.
        const quoteResponse = await this.#post(endpoint, body, {}, QUOTE_TIMEOUT_MS);
        const { required, amount } = this.verifyRequirement(await this.#requirementFrom(quoteResponse, endpoint), service, endpoint);

        // 4. Limits, then funds.
        const problems = await this.limitProblems(amount, maxPrice);
        if (problems.length) {
            throw new Refusal(`Not paying: ${problems.join('; ')}. Nothing was signed.`);
        }
        if (!(await this.hasFunds(amount))) {
            throw new Refusal(`Not paying: the wallet does not hold ${formatUsdc(amount)} USDC on ${network.label}. Add USDC on ${network.label} to the wallet set in BACON_WALLET_PRIVATE_KEY / BACON_WALLET_KEY_FILE and try again. Nothing was signed.`);
        }

        // 5. The buyer's confirmation, where the host can ask.
        const what = `Pay ${formatUsdc(amount)} USDC${network.testnet ? ' (test money)' : ''} on ${network.label} to Bacon Services to run ${service.tool}?`;
        if (!(await this.confirm(what))) {
            throw new Refusal('Payment declined. Nothing was signed.');
        }

        // 6. Reserve: duplicate, daily and session ceilings once more, atomically with the other processes.
        const reservation = await this.ledger.reserve({
            network: network.id,
            capability: service.id,
            fingerprint,
            amount,
            perDay: this.config.limits.perDay,
            allowRepeat: Boolean(args.allow_repeat),
            sessionCheck: (a) => (this.sessionCommitted + a > this.config.limits.perSession ? 'the per-session limit' : null),
        });
        if (reservation.duplicate) {
            return this.#earlier(reservation.duplicate, saveTo);
        }
        if (reservation.refused) {
            throw new Refusal(`Not paying: ${reservation.refused === 'day' ? 'the daily limit (BACON_MAX_PER_DAY) would be exceeded' : 'the per-session limit (BACON_MAX_PER_SESSION) would be exceeded'}. Nothing was signed.`);
        }
        const entry = reservation.entry;
        this.sessionCommitted += amount;

        // 7. Sign exactly this requirement, and check what was signed.
        let header;
        try {
            const payload = await this.http.createPaymentPayload(required);
            const auth = payload.payload?.authorization;
            if (payload.accepted?.amount !== required.accepts[0].amount || !auth || auth.value !== required.accepts[0].amount || !sameAddress(auth.to, this.config.payTo)) {
                throw new Error('the signed payment does not match the quote');
            }
            header = this.http.encodePaymentSignatureHeader(payload);
        } catch (error) {
            await this.#release(entry, amount);
            throw new Refusal(`Not paying: the payment could not be signed (${error.message}). Nothing was sent.`);
        }

        // 8. Send it, with the same body. One retry with the same payment if the connection drops.
        let response;
        try {
            response = await this.#post(endpoint, body, header, payTimeoutMs(service.entry), { retryOnce: true });
        } catch {
            await this.ledger.update(entry.id, 'uncertain');
            throw new Refusal(`The signed payment of ${formatUsdc(amount)} USDC was sent but no answer came back, so it may have been charged. It counts against your limits. Nothing will be re-sent automatically.`, { charged: 'unknown' });
        }
        return this.#settle(response, { entry, amount, service, contract, saveTo });
    }

    async #settle(response, { entry, amount, service, contract, saveTo }) {
        const { network, apiUrl } = this.config;
        const text = await response.text().catch(() => '');
        let data = null;
        try {
            data = JSON.parse(text);
        } catch {
            // not JSON: classified below
        }
        const receipt = this.#receipt(response);

        if (contract.output.kind === 'json' && response.status === 200 && data?.ok === true && data.result !== undefined) {
            return this.#deliverJson(data, { entry, amount, service, saveTo, receipt });
        }

        if (contract.output.kind === 'artifact' && response.status === 200 && data?.ok === true && typeof data.artifact?.url === 'string') {
            const transaction = data.payment?.transaction ?? receipt?.transaction ?? null;
            const artifact = {
                url: data.artifact.url,
                mime: data.artifact.mime ?? null,
                width: data.artifact.width ?? null,
                height: data.artifact.height ?? null,
                bytes: data.artifact.bytes ?? null,
                expires_at: data.artifact.expires_at ?? null,
            };
            await this.ledger.update(entry.id, 'spent', { request_id: data.request_id ?? null, transaction, artifact });
            const result = {
                ok: true,
                service: service.tool,
                paid_usdc: formatUsdc(amount),
                network: network.id,
                testnet: network.testnet,
                transaction,
                transaction_url: transaction ? network.explorer + transaction : null,
                request_id: data.request_id ?? null,
                artifact,
            };
            const warnings = [];
            if (artifact.mime !== contract.output.mime) {
                warnings.push(`Bacon returned ${artifact.mime}, expected ${contract.output.mime}.`);
            }
            if (saveTo) {
                const saved = await this.#download(artifact.url, saveTo.path, saveTo.overwrite);
                if (saved.ok) {
                    result.saved_to = saveTo.path;
                } else {
                    warnings.push(`Paid and delivered, but the file was not saved (${saved.reason}); download it from artifact.url before it expires.`);
                }
            }
            if (new URL(artifact.url).origin !== new URL(apiUrl).origin) {
                warnings.push('The artifact URL is not on Bacon\'s own address.');
            }
            if (warnings.length) {
                result.warnings = warnings;
            }
            return result;
        }

        if (response.status === 202 && data?.ok === true) {
            await this.ledger.update(entry.id, 'spent', { request_id: data.request_id ?? null, transaction: data.payment?.transaction ?? null });
            return { ok: true, service: service.tool, paid_usdc: formatUsdc(amount), status: 'queued', result_url: data.result_url ?? null, request_id: data.request_id ?? null,
                warnings: ['Bacon accepted this as a background job; poll result_url for the file.'] };
        }

        const reason = this.#reason(response, data);
        const requestId = data?.request_id ?? null;
        const notCharged = (response.status === 402 && !response.headers.get('payment-response'))
            || (response.status !== 402 && response.status !== 409 && NOT_CHARGED_CODES.has(data?.code));
        if (notCharged) {
            await this.#release(entry, amount);
            throw new Refusal(`Bacon did not take the payment: ${reason}. You have not been charged.`, { details: { request_id: requestId } });
        }
        await this.ledger.update(entry.id, 'uncertain', { request_id: requestId });
        throw new Refusal(`The payment of ${formatUsdc(amount)} USDC may have been charged, but no result came back (${reason}${requestId ? `; Bacon request id ${requestId}` : ''}). It counts against your limits; contact Bacon with the request id if you were charged.`, { charged: 'unknown', details: { request_id: requestId } });
    }

    /**
     * A JSON result (output.kind "json"): paid and delivered inline. Handed to the model only within
     * the capability's declared max_response_bytes (and this package's hard cap); checked against
     * the catalog's output schema, a mismatch reported as a warning (the money is already spent).
     */
    async #deliverJson(data, { entry, amount, service, saveTo, receipt }) {
        const { network } = this.config;
        const transaction = data.payment?.transaction ?? receipt?.transaction ?? null;
        const resultText = JSON.stringify(data.result);
        const size = Buffer.byteLength(resultText);
        const cap = Math.min(service.entry.limits.max_response_bytes, HARD_MAX_RESULT_BYTES);
        const fits = size <= cap;
        const warnings = [];
        if (!fits) {
            warnings.push(`The result is ${size} bytes, above the ${cap} bytes this service declares, so it is not shown${saveTo ? '' : '; pass save_to to keep it'}.`);
        }
        const valid = schemaCheck(service.entry.output.schema, data);
        if (valid !== true) {
            warnings.push(`The result does not match the service's declared output schema (${valid}).`);
        }
        await this.ledger.update(entry.id, 'spent', { request_id: data.request_id ?? null, transaction, ...(fits ? { result: data.result } : {}) });

        const result = {
            ok: true,
            service: service.tool,
            paid_usdc: formatUsdc(amount),
            network: network.id,
            testnet: network.testnet,
            transaction,
            transaction_url: transaction ? network.explorer + transaction : null,
            request_id: data.request_id ?? null,
            result: fits ? data.result : null,
        };
        if (saveTo) {
            try {
                writeFileSync(saveTo.path, `${JSON.stringify(data.result, null, 2)}\n`, { flag: saveTo.overwrite ? 'w' : 'wx' });
                result.saved_to = saveTo.path;
            } catch (error) {
                warnings.push(`Paid and delivered, but the file was not saved (${error.code === 'EEXIST' ? `${saveTo.path} already exists` : error.message}).`);
            }
        }
        if (warnings.length) {
            result.warnings = warnings;
        }
        return result;
    }

    #reason(response, data) {
        let reason = data?.error;
        if (response.status === 402) {
            try {
                reason = this.http.getPaymentRequiredResponse((name) => response.headers.get(name), data)?.error ?? reason;
            } catch {
                // keep the body's reason
            }
            if (/insufficient/i.test(String(reason))) {
                return 'the wallet does not have enough USDC (insufficient_funds)';
            }
        }
        return `${response.status}${reason ? ` ${reason}` : ''}`;
    }

    #receipt(response) {
        try {
            return response.headers.get('payment-response') ? this.http.getPaymentSettleResponse((name) => response.headers.get(name)) : null;
        } catch {
            return null;
        }
    }

    async #release(entry, amount) {
        await this.ledger.update(entry.id, 'released');
        this.sessionCommitted -= amount;
    }

    async #earlier(entry, saveTo) {
        if (entry.status === 'spent' && entry.result !== undefined) {
            const result = {
                ok: true,
                repeat: true,
                note: `Already bought at ${new Date(entry.created_at).toISOString()}; not charged again. Pass allow_repeat: true to buy it again.`,
                service: entry.capability,
                paid_usdc: formatUsdc(entry.amount),
                transaction: entry.transaction ?? null,
                request_id: entry.request_id ?? null,
                result: entry.result,
            };
            if (saveTo) {
                try {
                    writeFileSync(saveTo.path, `${JSON.stringify(entry.result, null, 2)}\n`, { flag: saveTo.overwrite ? 'w' : 'wx' });
                    result.saved_to = saveTo.path;
                } catch (error) {
                    result.warnings = [`The file was not saved (${error.message}).`];
                }
            }
            return result;
        }
        if (entry.status === 'spent' && !entry.artifact?.url) {
            throw new Refusal(`Not paying: the same request was bought at ${new Date(entry.created_at).toISOString()}${entry.request_id ? ` (Bacon request id ${entry.request_id})` : ''}, but its result was too large to keep. Pass allow_repeat: true to buy it again.`);
        }
        if (entry.status !== 'spent' || !entry.artifact?.url) {
            throw new Refusal(`Not paying: the same request was started at ${new Date(entry.created_at).toISOString()} and its outcome is ${entry.status === 'reserved' ? 'still pending' : 'unknown'}${entry.request_id ? ` (Bacon request id ${entry.request_id})` : ''}, so it may have been charged. Pass allow_repeat: true to buy it again anyway.`, { charged: 'unknown' });
        }
        const result = {
            ok: true,
            repeat: true,
            note: `Already bought at ${new Date(entry.created_at).toISOString()}; not charged again. Pass allow_repeat: true to buy it again.`,
            service: entry.capability,
            paid_usdc: formatUsdc(entry.amount),
            transaction: entry.transaction ?? null,
            request_id: entry.request_id ?? null,
            artifact: entry.artifact,
        };
        if (saveTo) {
            const saved = await this.#download(entry.artifact.url, saveTo.path, saveTo.overwrite);
            if (saved.ok) {
                result.saved_to = saveTo.path;
            } else {
                result.warnings = [`The file was not saved (${saved.reason}).`];
            }
        }
        return result;
    }

    async #download(url, path, overwrite) {
        try {
            const response = await this.fetch(url, { signal: AbortSignal.timeout(60_000) });
            if (!response.ok) {
                return { ok: false, reason: `download answered ${response.status}` };
            }
            writeFileSync(path, Buffer.from(await response.arrayBuffer()), { flag: overwrite ? 'w' : 'wx' });
            return { ok: true };
        } catch (error) {
            return { ok: false, reason: error.code === 'EEXIST' ? `${path} already exists` : error.message };
        }
    }

    async #requirementFrom(response, endpoint) {
        if (response.status !== 402) {
            const data = await response.json().catch(() => null);
            throw new Refusal(`Bacon refused the request before any payment (${response.status}${data?.error ? ` ${data.error}` : ''}). Nothing was signed.`);
        }
        try {
            const body = await response.clone().json().catch(() => undefined);
            return this.http.getPaymentRequiredResponse((name) => response.headers.get(name), body);
        } catch {
            throw new Refusal(`Not paying: ${endpoint} answered 402 without a readable payment requirement. Nothing was signed.`);
        }
    }

    async #post(url, body, paymentHeaders, timeout, { retryOnce = false } = {}) {
        const send = () => this.fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...paymentHeaders },
            body,
            signal: AbortSignal.timeout(timeout),
        });
        try {
            return await send();
        } catch (error) {
            if (retryOnce) {
                return send();
            }
            throw new Refusal(`Could not reach Bacon at ${url} (${error.name === 'TimeoutError' ? 'timed out' : error.message}). Nothing was signed.`);
        }
    }
}

const SIGNATURES = [
    ['image/png', (b) => b.length > 8 && b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG'],
    ['image/jpeg', (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
    ['image/webp', (b) => b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP'],
];

/** Exactly one of image_url (https) or image_path (a local PNG/JPEG/WebP within Bacon's size limit). */
export function prepareImage(args, limits) {
    const hasUrl = typeof args.image_url === 'string' && args.image_url.trim() !== '';
    const hasPath = typeof args.image_path === 'string' && args.image_path.trim() !== '';
    if (hasUrl === hasPath) {
        throw new Refusal('Give exactly one of image_url or image_path.');
    }
    if (hasUrl) {
        let url;
        try {
            url = new URL(args.image_url.trim());
        } catch {
            throw new Refusal('image_url is not a URL.');
        }
        if (url.protocol !== 'https:') {
            throw new Refusal('image_url must be a public https URL.');
        }
        return { body: { image_url: url.href }, identity: `url:${url.href}` };
    }
    const path = resolve(args.image_path.trim());
    let size;
    try {
        size = statSync(path).size;
    } catch {
        throw new Refusal(`image_path ${path} cannot be read.`);
    }
    if (size > limits.max_bytes) {
        throw new Refusal(`image_path is ${size} bytes; Bacon takes at most ${limits.max_bytes}.`);
    }
    const bytes = readFileSync(path);
    const mime = SIGNATURES.find(([, test]) => test(bytes))?.[0];
    if (!mime || !limits.formats.includes(mime)) {
        throw new Refusal(`image_path must be ${limits.formats.map((f) => f.replace('image/', '').toUpperCase()).join(', ')}.`);
    }
    return { body: { image_base64: bytes.toString('base64') }, identity: `sha256:${sha256(bytes)}` };
}

/**
 * One public web page for a URL capability: http(s), no user:pass@, ports 80/443 only, within
 * the catalog's maxLength. Bacon checks it again (and that it is public) before quoting.
 */
export function prepareUrl(args, inputSchema) {
    if (typeof args.url !== 'string' || args.url.trim() === '') {
        throw new Refusal('Give url: the address of one public web page.');
    }
    const raw = args.url.trim();
    const maxLength = inputSchema?.properties?.url?.maxLength ?? 2048;
    if (raw.length > maxLength) {
        throw new Refusal(`url is ${raw.length} characters; Bacon takes at most ${maxLength}.`);
    }
    let url;
    try {
        url = new URL(raw);
    } catch {
        throw new Refusal('url is not a URL.');
    }
    if (!['http:', 'https:'].includes(url.protocol)) {
        throw new Refusal('url must be an http or https address.');
    }
    if (url.username || url.password) {
        throw new Refusal('url must not contain a user name or password.');
    }
    if (url.port !== '') {
        throw new Refusal('url must use the standard port (80 or 443).');
    }
    return { body: { url: url.href }, identity: `page:${url.href}` };
}

/** The contract's options, defaults filled in: integers within their bounds, booleans as booleans, named values from their list. */
export function prepareOptions(args, contract) {
    const options = {};
    for (const [name, spec] of Object.entries(contract.options)) {
        const value = args[name] ?? spec.default;
        if (spec.type === 'boolean') {
            if (typeof value !== 'boolean') {
                throw new Refusal(`${name} must be true or false.`);
            }
        } else if (spec.enum) {
            if (!spec.enum.includes(value)) {
                throw new Refusal(`${name} must be one of: ${spec.enum.join(', ')}.`);
            }
        } else if (!Number.isInteger(value) || value < spec.minimum || value > spec.maximum) {
            throw new Refusal(`${name} must be a whole number from ${spec.minimum} to ${spec.maximum}.`);
        }
        options[name] = value;
    }
    return options;
}

/** true, or a short description of the first way `data` breaks `schema`. */
export function schemaCheck(schema, data) {
    let validate = validators.get(schema);
    if (!validate) {
        try {
            validate = ajv.compile(schema);
        } catch (error) {
            return `the schema could not be read: ${error.message}`;
        }
        validators.set(schema, validate);
    }
    if (validate(data)) {
        return true;
    }
    const [first] = validate.errors ?? [];
    return first ? `${first.instancePath || '/'} ${first.message}` : 'invalid';
}

function prepareSaveTo(args) {
    if (typeof args.save_to !== 'string' || args.save_to.trim() === '') {
        return null;
    }
    const path = resolve(args.save_to.trim());
    if (!existsSync(dirname(path))) {
        throw new Refusal(`save_to: the folder ${dirname(path)} does not exist.`);
    }
    if (existsSync(path) && !args.overwrite) {
        throw new Refusal(`save_to: ${path} already exists (pass overwrite: true to replace it).`);
    }
    return { path, overwrite: Boolean(args.overwrite) };
}

function sha256(data) {
    return createHash('sha256').update(data).digest('hex');
}
