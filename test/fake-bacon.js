// A stand-in for Bacon's Agent Commerce API, as a fetch function (and an http server for the
// stdio test). Its catalogs are real ones saved as fixtures: today's production catalog
// (fixtures/catalog-legacy.json, no contract fields) and the catalog with contract fields and the
// JSON-result services (fixtures/catalog-contract-v1.json, dumped from the next-capabilities
// branch's own controller). It answers like production and checks every payment for real: the EIP-712 signature is verified with viem,
// the amount, payee, asset and network must match the quote, and a nonce settles once — the same
// payment and body again gets the same result (Bacon's idempotent replay), anything else a 409.

import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { verifyTypedData } from 'viem';
import { NETWORKS } from '../src/networks.js';

export const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake png body')]);
export const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPfake webp body')]);
export const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 800 600" width="800" height="600"><path fill="rgb(1,2,3)" d="M 0 0 L 8 0 Z "/></svg>');

const FIXTURES = {
    legacy: JSON.parse(readFileSync(new URL('./fixtures/catalog-legacy.json', import.meta.url), 'utf8')),
    v1: JSON.parse(readFileSync(new URL('./fixtures/catalog-contract-v1.json', import.meta.url), 'utf8')),
};

const TRANSFER = {
    TransferWithAuthorization: [
        { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
    ],
};

export function createFakeBacon({ networkKey = 'base', apiUrl = 'https://baconservices.com', payTo = NETWORKS.base.payTo, contract = 'legacy' } = {}) {
    const network = NETWORKS[networkKey];
    const base = `${apiUrl}/api/agent-commerce/v1`;

    const fake = {
        network,
        apiUrl,
        payTo,
        balances: new Map(), // lowercased address → atomic
        rpcDown: false,
        // Knobs a test turns to make Bacon misbehave.
        tweak: {},
        catalogEdit: null, // (catalog) => catalog
        log: [], // every request: { method, path, paid, body }
        settled: [], // { nonce, amount, from, capability }
        paymentHeaders: [],
        payments: new Map(), // nonce → { payloadHash, bodyHash, response }
        dropAfterProcessing: 0, // the next N paid requests are processed, then the connection "drops"
    };

    // The saved catalog, moved to this fake's address and network.
    fake.catalog = () => {
        const catalog = structuredClone(FIXTURES[contract]);
        catalog.network = { id: network.id, label: network.label, testnet: network.testnet };
        for (const c of catalog.capabilities) {
            c.endpoint.url = `${base}/capabilities/${c.id}/execute`;
            c.price.asset = network.usdc.address;
        }
        return fake.catalogEdit ? fake.catalogEdit(catalog) : catalog;
    };

    const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
    const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64');

    function requirement(id) {
        const listed = fake.catalog().capabilities.find((c) => c.id === id) ?? fake.catalog().capabilities[0];
        const t = fake.tweak;
        return {
            x402Version: 2,
            resource: { url: t.resourceUrl ?? `${base}/capabilities/${id}/execute`, description: listed.name, mimeType: 'application/json', serviceName: 'Bacon Services' },
            accepts: [{
                scheme: 'exact',
                network: t.network ?? network.id,
                amount: t.amount ?? listed.price.amount,
                asset: t.asset ?? network.usdc.address,
                payTo: t.payTo ?? payTo,
                maxTimeoutSeconds: 120,
                extra: { name: network.usdc.name, version: network.usdc.version },
            }],
            extensions: { bazaar: { info: {} } },
        };
    }

    function paymentRequired(id, error, extraHeaders = {}) {
        const document = { ...requirement(id), error };
        return json(402, document, { 'PAYMENT-REQUIRED': b64(document), ...extraHeaders });
    }

    async function paid(id, bodyText, header) {
        const want = requirement(id).accepts[0];
        let payment;
        try {
            payment = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
        } catch {
            return paymentRequired(id, 'invalid_payment_payload');
        }
        const auth = payment.payload?.authorization ?? {};
        const nonce = String(auth.nonce).toLowerCase();
        const payloadHash = createHash('sha256').update(header).digest('hex');
        const bodyHash = createHash('sha256').update(bodyText).digest('hex');
        const previous = fake.payments.get(nonce);
        if (previous) {
            return previous.payloadHash === payloadHash && previous.bodyHash === bodyHash && previous.response
                ? json(200, previous.response.body, previous.response.headers)
                : json(409, { ok: false, code: 'payment_already_used', error: 'This payment has already been used.' });
        }
        const ok = payment.x402Version === 2 && payment.accepted?.amount === want.amount && payment.accepted?.network === want.network
            && auth.value === want.amount && String(auth.to).toLowerCase() === want.payTo.toLowerCase();
        const valid = ok && await verifyTypedData({
            address: auth.from,
            domain: { name: network.usdc.name, version: network.usdc.version, chainId: network.chainId, verifyingContract: network.usdc.address },
            types: TRANSFER,
            primaryType: 'TransferWithAuthorization',
            message: { ...auth, value: BigInt(auth.value), validAfter: BigInt(auth.validAfter), validBefore: BigInt(auth.validBefore) },
            signature: payment.payload.signature,
        }).catch(() => false);
        if (!valid) {
            return paymentRequired(id, 'invalid_signature');
        }
        if (fake.tweak.verify === 'insufficient_funds' || (fake.balances.get(String(auth.from).toLowerCase()) ?? 0n) < BigInt(want.amount)) {
            return paymentRequired(id, 'insufficient_funds');
        }
        if (fake.tweak.executeFailure) {
            const [status, body] = fake.tweak.executeFailure;
            return typeof body === 'string' ? new Response(body, { status, headers: { 'Content-Type': 'text/html' } }) : json(status, body);
        }
        if (fake.tweak.settle === 'fail') {
            return paymentRequired(id, 'settle_exact_failed', { 'PAYMENT-RESPONSE': b64({ success: false, errorReason: 'settle_exact_failed', transaction: '', network: want.network }) });
        }
        const requestId = randomUUID();
        const transaction = `0x${createHash('sha256').update(nonce).digest('hex')}`;
        const listed = fake.catalog().capabilities.find((c) => c.id === id);
        const receiptInfo = { network: want.network, testnet: network.testnet, transaction };
        let body;
        if (listed?.output?.kind === 'json') {
            // A JSON result inline, as Bacon's deliveredJson() answers: the catalog's own example unless a test overrides it.
            body = { ok: true, request_id: requestId, capability: id, result: fake.tweak.jsonResult ?? listed.output.example, payment: receiptInfo };
        } else {
            const mime = listed?.output?.mime ?? (id === 'remove-background' ? 'image/png' : 'image/webp');
            body = {
                ok: true,
                request_id: requestId,
                capability: id,
                artifact: { url: `${base}/artifacts/${requestId}?expires=1&signature=abc`, mime, bytes: 20, width: 800, height: 600, expires_at: '2099-01-01T00:00:00+00:00' },
                payment: receiptInfo,
            };
        }
        const headers = { 'PAYMENT-RESPONSE': b64({ success: true, transaction, network: want.network, payer: auth.from }) };
        fake.payments.set(nonce, { payloadHash, bodyHash, response: { body, headers } });
        fake.settled.push({ nonce, amount: want.amount, from: String(auth.from).toLowerCase(), capability: id });
        fake.balances.set(String(auth.from).toLowerCase(), (fake.balances.get(String(auth.from).toLowerCase()) ?? 0n) - BigInt(want.amount));
        return json(200, body, headers);
    }

    fake.handle = async (request) => {
        const url = new URL(request.url);
        const path = url.pathname;
        const bodyText = request.method === 'POST' ? await request.text() : '';
        const header = request.headers.get('payment-signature');
        fake.log.push({ method: request.method, path, paid: Boolean(header), body: bodyText });

        if (path === '/rpc') {
            const rpc = JSON.parse(bodyText);
            if (fake.rpcDown) {
                return json(503, { error: 'down' });
            }
            const owner = `0x${rpc.params[0].data.slice(-40)}`.toLowerCase();
            return json(200, { jsonrpc: '2.0', id: rpc.id, result: `0x${(fake.balances.get(owner) ?? 0n).toString(16).padStart(64, '0')}` });
        }
        if (request.method === 'GET' && path === '/api/agent-commerce/v1/capabilities') {
            return fake.tweak.catalogClosed ? json(404, { message: 'Not Found' }) : json(200, fake.catalog());
        }
        if (request.method === 'GET' && path.startsWith('/api/agent-commerce/v1/artifacts/')) {
            const id = path.split('/').pop();
            const settledFor = [...fake.payments.values()].find((p) => p.response?.body.request_id === id);
            if (!settledFor) {
                return json(404, {});
            }
            const bytes = { 'image/png': PNG, 'image/svg+xml': SVG }[settledFor.response.body.artifact.mime] ?? WEBP;
            return new Response(bytes, { status: 200, headers: { 'Content-Type': settledFor.response.body.artifact.mime } });
        }
        const match = /^\/api\/agent-commerce\/v1\/capabilities\/([a-z-]+)\/execute$/.exec(path);
        if (request.method === 'POST' && match) {
            const id = match[1];
            let body;
            try {
                body = JSON.parse(bodyText || '{}');
            } catch {
                return json(400, { ok: false, code: 'invalid_input', error: 'Not JSON.' });
            }
            if (Object.keys(body).length === 0 && !header) {
                return paymentRequired(id, 'Send the image in the JSON body to get a quote for it.');
            }
            if (id === 'brand-from-url') {
                if (typeof body.url !== 'string' || Object.keys(body).length !== 1) {
                    return json(422, { ok: false, code: 'invalid_input', error: 'Give url.' });
                }
                if (fake.tweak.hostBusyAtQuote) {
                    return json(503, { ok: false, code: 'busy', error: 'This site has been read too often in the last hour. Try again later.' });
                }
            } else if (Boolean(body.image_url) === Boolean(body.image_base64)) {
                return json(422, { ok: false, code: 'invalid_input', error: 'Give exactly one of image_url or image_base64.' });
            }
            if (!header) {
                return paymentRequired(id, 'PAYMENT-SIGNATURE header is required');
            }
            fake.paymentHeaders.push(header);
            const response = await paid(id, bodyText, header);
            if (fake.dropAfterProcessing > 0) {
                fake.dropAfterProcessing -= 1;
                throw new TypeError('fetch failed (connection reset)');
            }
            return response;
        }
        return json(404, {});
    };

    fake.fetch = async (input, init = {}) => {
        const request = new Request(input, init);
        if (!request.url.startsWith(apiUrl) && !request.url.startsWith(`${apiUrl.replace(/\/$/, '')}/rpc`)) {
            throw new TypeError(`fake Bacon was asked for ${request.url}`);
        }
        return fake.handle(request);
    };

    fake.balanceOf = async (asset, owner) => {
        if (fake.rpcDown) {
            throw new Error('RPC down');
        }
        if (asset.toLowerCase() !== network.usdc.address.toLowerCase()) {
            throw new Error('asked for the wrong asset');
        }
        return fake.balances.get(owner.toLowerCase()) ?? 0n;
    };

    fake.paidRequests = () => fake.log.filter((r) => r.paid).length;

    /** Serves the fake over real HTTP (for the stdio test); resolves with the base URL. */
    fake.listen = (port = 0) => new Promise((resolve) => {
        const httpServer = createServer(async (req, res) => {
            const chunks = [];
            for await (const chunk of req) {
                chunks.push(chunk);
            }
            const request = new Request(`${fake.apiUrl}${req.url}`, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) });
            const response = await fake.handle(request);
            res.writeHead(response.status, Object.fromEntries(response.headers));
            res.end(Buffer.from(await response.arrayBuffer()));
        });
        fake.close = () => new Promise((done) => httpServer.close(done));
        httpServer.listen(port, '127.0.0.1', () => resolve(httpServer.address().port));
    });

    return fake;
}
