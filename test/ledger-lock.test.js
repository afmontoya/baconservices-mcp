// What the ledger lock does when it cannot be taken. The open is injected, so the Windows
// delete-pending EPERM is simulated on any platform and no test depends on a real race.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, openSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Ledger, LedgerError } from '../src/ledger.js';
import { tempDir } from './helpers.js';

const WAIT_MS = 60;
// The wait sleeps 20 ms a round, so a 60 ms deadline allows a handful of opens, however slow the machine.
const MAX_OPENS = 10;

function failure(code) {
    return Object.assign(new Error(code), { code });
}

/** Fails the first `times` opens with `code`, then opens for real. A loop that ignores the deadline ends here instead of hanging the run. */
function countedOpen(code, times = Infinity) {
    const open = (path, flags) => {
        open.calls += 1;
        if (open.calls > 500) {
            throw failure('ERUNAWAY');
        }
        if (open.calls <= times) {
            throw failure(code);
        }
        return openSync(path, flags);
    };
    open.calls = 0;
    return open;
}

function reserve(ledger, checks = { count: 0 }) {
    return ledger.reserve({
        network: 'eip155:8453',
        capability: 'x',
        fingerprint: 'f',
        amount: 1n,
        perDay: 40n,
        allowRepeat: false,
        sessionCheck: () => {
            checks.count += 1;
            return null;
        },
    });
}

function lockFileIn(dir) {
    mkdirSync(dir, { recursive: true });
    return join(dir, 'spend-ledger.lock');
}

test('on Windows, an EPERM from the lock open is waited out and the reservation goes through', async () => {
    const dir = tempDir();
    const openLock = countedOpen('EPERM', 2);
    const result = await reserve(new Ledger(dir, { openLock, platform: 'win32' }));

    assert.ok(result.entry, 'the reservation was made');
    assert.equal(openLock.calls, 3, 'two refusals, then the open that took the lock');
    assert.equal(JSON.parse(readFileSync(join(dir, 'spend-ledger.json'), 'utf8')).entries.length, 1);
    assert.equal(existsSync(join(dir, 'spend-ledger.lock')), false, 'the lock was released');
});

test('on Windows, an EPERM that never clears refuses once the wait is over, and nothing is reserved', async () => {
    const dir = tempDir();
    const openLock = countedOpen('EPERM');
    const checks = { count: 0 };

    await assert.rejects(reserve(new Ledger(dir, { openLock, platform: 'win32', lockWaitMs: WAIT_MS }), checks), (error) => {
        assert.ok(error instanceof LedgerError);
        assert.match(error.message, /cannot be created \(EPERM\)/);
        return true;
    });
    assert.ok(openLock.calls > 1, 'it waited before refusing');
    assert.ok(openLock.calls <= MAX_OPENS, `it slept between tries (${openLock.calls} opens)`);
    assert.equal(checks.count, 0, 'the limits were never reached without the lock');
    assert.equal(existsSync(join(dir, 'spend-ledger.json')), false, 'nothing was written');
});

test('off Windows, EPERM is a real permission problem: refused at once', async () => {
    const openLock = countedOpen('EPERM');

    await assert.rejects(reserve(new Ledger(tempDir(), { openLock, platform: 'linux' })), /cannot be created \(EPERM\)/);
    assert.equal(openLock.calls, 1);
});

for (const code of ['EACCES', 'ENOSPC']) {
    test(`on Windows, ${code} is not contention: refused at once`, async () => {
        const openLock = countedOpen(code);

        await assert.rejects(reserve(new Ledger(tempDir(), { openLock, platform: 'win32' })), new RegExp(`cannot be created \\(${code}\\)`));
        assert.equal(openLock.calls, 1);
    });
}

test('a lock another process holds refuses once the wait is over, and says so', async () => {
    const dir = tempDir();
    writeFileSync(lockFileIn(dir), '');
    const openLock = countedOpen('unused', 0);

    await assert.rejects(reserve(new Ledger(dir, { openLock, lockWaitMs: WAIT_MS })), /locked by another process/);
    assert.ok(openLock.calls > 1, 'it waited before refusing');
    assert.equal(existsSync(join(dir, 'spend-ledger.lock')), true, 'a fresh lock is left alone');
});

test('a stale lock is taken over', async () => {
    const dir = tempDir();
    const lockFile = lockFileIn(dir);
    writeFileSync(lockFile, '');
    utimesSync(lockFile, new Date(0), new Date(0));

    assert.ok((await reserve(new Ledger(dir))).entry);
    assert.equal(existsSync(lockFile), false);
});

test('a stale lock that cannot be removed still ends at the deadline', async () => {
    const dir = tempDir();
    const lockFile = lockFileIn(dir);
    mkdirSync(lockFile); // rmSync without `recursive` refuses a directory, every time.
    utimesSync(lockFile, new Date(0), new Date(0));
    const openLock = countedOpen('unused', 0);

    await assert.rejects(reserve(new Ledger(dir, { openLock, lockWaitMs: WAIT_MS })), /locked by another process/);
    assert.ok(openLock.calls <= MAX_OPENS, `it slept between tries (${openLock.calls} opens)`);
});
