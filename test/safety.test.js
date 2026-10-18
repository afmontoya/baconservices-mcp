// Confirmation, the network guard, wallet privacy and the private key.

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { KEY, connect, tempDir } from './helpers.js';
import { createFakeBacon } from './fake-bacon.js';

const URL1 = { image_url: 'https://example.com/a.png' };

test('a host that can ask shows the price and pays only on approval', async () => {
    const declined = await connect({ elicit: async () => ({ action: 'accept', content: { pay: false } }) });
    const no = await declined.call('remove_background', URL1);
    assert.equal(no.error, true);
    assert.match(no.data.error, /Payment declined\. Nothing was signed/);
    assert.deepEqual(declined.asked, ['Pay 0.2 USDC on Base to Bacon Services to run remove_background?']);
    assert.equal(declined.fake.paymentHeaders.length, 0);

    const cancelled = await connect({ elicit: async () => ({ action: 'cancel' }) });
    assert.equal((await cancelled.call('remove_background', URL1)).error, true);
    assert.equal(cancelled.fake.paymentHeaders.length, 0);

    const approved = await connect({ elicit: async () => ({ action: 'accept', content: { pay: true } }) });
    assert.equal((await approved.call('remove_background', URL1)).error, false);
    assert.equal(approved.fake.settled.length, 1);
});

test('the limits are checked before the buyer is asked', async () => {
    const asked = await connect({ env: { BACON_MAX_PER_CALL: '0.1' }, elicit: async () => ({ action: 'accept', content: { pay: true } }) });
    await asked.call('remove_background', URL1);
    assert.deepEqual(asked.asked, [], 'never asked to approve something the limits refuse');
});

test('BACON_CONFIRM=always refuses on a host that cannot ask; never pays without asking', async () => {
    const always = await connect({ env: { BACON_CONFIRM: 'always' } });
    const refused = await always.call('optimize_image', URL1);
    assert.match(refused.data.error, /BACON_CONFIRM=always, but this MCP host cannot ask/);
    assert.equal(always.fake.paymentHeaders.length, 0);

    const never = await connect({ env: { BACON_CONFIRM: 'never' }, elicit: async () => ({ action: 'accept', content: { pay: false } }) });
    assert.equal((await never.call('optimize_image', URL1)).error, false);
    assert.deepEqual(never.asked, []);

    const auto = await connect();
    assert.equal((await auto.call('optimize_image', URL1)).error, false, 'auto on a host that cannot ask: the limits are the safety boundary');
    assert.equal((await auto.call('wallet_status')).data.confirmation.host_can_ask, false);
});

test('network guard: real money only with production, test money never with production', async () => {
    const cases = [
        [{ BACON_NETWORK: 'base', BACON_API_URL: 'http://127.0.0.1:9000' }, /only talks to https:\/\/baconservices\.com/],
        [{ BACON_NETWORK: 'base-sepolia', BACON_API_URL: 'https://baconservices.com', BACON_PAY_TO: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C' }, /cannot use production/],
        [{ BACON_NETWORK: 'base-sepolia', BACON_API_URL: 'https://www.baconservices.com/', BACON_PAY_TO: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C' }, /cannot use production/],
        [{ BACON_NETWORK: 'base-sepolia', BACON_PAY_TO: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C' }, /needs BACON_API_URL/],
        [{ BACON_NETWORK: 'base-sepolia', BACON_API_URL: 'http://127.0.0.1:9000' }, /needs BACON_PAY_TO/],
        [{ BACON_NETWORK: 'base-sepolia', BACON_API_URL: 'http://test.example', BACON_PAY_TO: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C' }, /must be https/],
        [{ BACON_PAY_TO: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C' }, /cannot change Bacon's receiving address on Base/],
        [{ BACON_NETWORK: 'ethereum' }, /must be "base" .* or "base-sepolia"/],
    ];
    for (const [env, message] of cases) {
        const { call, fake } = await connect({ env });
        const result = await call('remove_background', URL1);
        assert.match(result.data.error, message, JSON.stringify(env));
        assert.equal(fake.log.length, 0, `${JSON.stringify(env)}: nothing fetched`);
        assert.match((await call('wallet_status')).data.configuration_problems.join(' '), message);
    }
});

test('a test-money signer against a Bacon that sells for real money (and the reverse) pays nothing', async () => {
    const mainnetBacon = createFakeBacon({ networkKey: 'base', apiUrl: 'http://127.0.0.1:9000' });
    const testSigner = await connect({ fake: mainnetBacon, env: { BACON_NETWORK: 'base-sepolia', BACON_API_URL: 'http://127.0.0.1:9000', BACON_PAY_TO: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C' } });
    assert.deepEqual((await testSigner.client.listTools()).tools.map((t) => t.name), ['list_services', 'quote', 'wallet_status']);
    assert.match((await testSigner.call('list_services')).data.error, /sells on eip155:8453, but this package is set to eip155:84532/);
    assert.match((await testSigner.call('remove_background', URL1)).data.error, /Nothing can be paid until they match/);

    const testBacon = createFakeBacon({ networkKey: 'base-sepolia' });
    const realSigner = await connect({ fake: testBacon });
    assert.match((await realSigner.call('optimize_image', URL1)).data.error, /sells on eip155:84532 \(testnet\), but this package is set to eip155:8453/);
    assert.equal(mainnetBacon.paymentHeaders.length + testBacon.paymentHeaders.length, 0);
});

test('test money: pays a test copy of Bacon on Base Sepolia, to the configured test payee', async () => {
    const payTo = '0x209693Bc6afc0C5328bA36FaF03C514EF312287C';
    const fake = createFakeBacon({ networkKey: 'base-sepolia', apiUrl: 'http://127.0.0.1:9000', payTo });
    const { call } = await connect({ fake, env: { BACON_NETWORK: 'base-sepolia', BACON_API_URL: 'http://127.0.0.1:9000', BACON_PAY_TO: payTo } });
    const result = await call('optimize_image', URL1);
    assert.equal(result.error, false, result.text);
    assert.equal(result.data.testnet, true);
    assert.match(result.data.transaction_url, /^https:\/\/sepolia\.basescan\.org\/tx\//);
    assert.equal(fake.settled.length, 1);
});

test('wallet_status keeps the exact balance and address private unless the buyer opts in', async () => {
    const hidden = await connect({ balance: 150_000n });
    const status = (await hidden.call('wallet_status')).data;
    assert.equal(status.wallet_configured, true);
    assert.deepEqual(status.can_afford, { remove_background: 'no', optimize_image: 'yes' });
    assert.equal('usdc_balance' in status, false);
    assert.equal('address' in status, false);
    assert.doesNotMatch(JSON.stringify(status), /0\.15|0x[0-9a-fA-F]{40}/);
    assert.deepEqual((await hidden.call('wallet_status', { service: 'remove_background' })).data.can_afford, { remove_background: 'no' });

    const shown = await connect({ balance: 150_000n, env: { BACON_DISCLOSE_BALANCE: 'true' } });
    const disclosed = (await shown.call('wallet_status')).data;
    assert.equal(disclosed.usdc_balance, '0.15');
    assert.match(disclosed.address, /^0x[0-9a-fA-F]{40}$/);
});

test('the private key never appears in any tool result, whatever happens', async () => {
    const bare = KEY.slice(2);
    const outputs = [];
    const record = async (session, name, args) => outputs.push((await session.call(name, args)).text);

    const ok = await connect();
    for (const [name, args] of [['list_services', {}], ['wallet_status', {}], ['quote', { service: 'remove_background' }], ['remove_background', URL1], ['optimize_image', { image_path: 'missing.png' }]]) {
        await record(ok, name, args);
    }
    const broken = createFakeBacon();
    broken.tweak.executeFailure = [500, { ok: false, code: 'boom', error: `echo ${KEY} ${bare.toUpperCase()}` }];
    await record(await connect({ fake: broken }), 'remove_background', URL1);
    await record(await connect({ env: { BACON_WALLET_PRIVATE_KEY: `${KEY}ff` } }), 'remove_background', URL1);
    await record(await connect({ env: { BACON_WALLET_PRIVATE_KEY: bare.slice(0, 40) } }), 'wallet_status', {});
    await record(await connect({ env: { BACON_WALLET_PRIVATE_KEY: `"${bare}"` } }), 'remove_background', { image_url: 'https://example.com/b.png' });

    const all = outputs.join('\n');
    assert.match(all, /\[redacted\]/, 'the echoed key was caught');
    assert.match(all, /has 66 characters after 0x/);
    for (const needle of [bare, bare.toUpperCase(), bare.slice(0, 40)]) {
        assert.equal(all.toLowerCase().includes(needle.toLowerCase()), false);
    }
});

test('the key can come from a file instead of the host\'s config; both at once is refused', async () => {
    const dir = tempDir();
    const file = join(dir, 'buyer.key');
    writeFileSync(file, `${KEY}\n`);
    const fromFile = await connect({ env: { BACON_WALLET_PRIVATE_KEY: '', BACON_WALLET_KEY_FILE: file } });
    assert.equal((await fromFile.call('optimize_image', URL1)).error, false);

    const both = await connect({ env: { BACON_WALLET_KEY_FILE: file } });
    assert.match((await both.call('optimize_image', URL1)).data.error, /Set only one of/);
});
