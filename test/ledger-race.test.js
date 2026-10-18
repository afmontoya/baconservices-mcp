// The ledger lock across real processes: several processes reserving against one ceiling at
// once must never reserve more than it, and never lose a write.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers.js';

const LEDGER = fileURLToPath(new URL('../src/ledger.js', import.meta.url));

test('four processes reserving at once stop exactly at the daily ceiling', async () => {
    const dir = tempDir();
    const worker = join(dir, 'worker.mjs');
    writeFileSync(worker, `
        import { Ledger } from ${JSON.stringify(new URL(`file:///${LEDGER.replace(/\\/g, '/')}`).href)};
        const ledger = new Ledger(process.argv[2]);
        let ok = 0;
        for (let i = 0; i < 15; i++) {
            const r = await ledger.reserve({ network: 'eip155:8453', capability: 'x', fingerprint: process.pid + '-' + i, amount: 1n, perDay: 40n, allowRepeat: false, sessionCheck: () => null });
            if (r.entry) ok++;
        }
        process.stdout.write(String(ok));
    `);
    const runs = await Promise.all([1, 2, 3, 4].map(() => new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [worker, join(dir, 'ledger')]);
        let out = '';
        let err = '';
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { err += d; });
        child.on('close', (code) => (code === 0 ? resolve(Number(out)) : reject(new Error(err))));
    })));
    const entries = JSON.parse(readFileSync(join(dir, 'ledger', 'spend-ledger.json'), 'utf8')).entries;
    assert.equal(runs.reduce((a, b) => a + b, 0), 40, 'exactly the ceiling was granted (60 asked)');
    assert.equal(entries.length, 40, 'every granted reservation is on disk: no lost writes');
});
