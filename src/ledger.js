// The local spend ledger: one JSON file that survives restarts of the MCP process.
//
// It holds the daily ceiling (a rolling 24 hours, so restarting the process, or running several
// at once, never opens a new budget) and the record of recent purchases that stops an accidental
// retry from paying twice. Every read-check-write happens under a lock file, so two processes
// cannot both pass the ceiling check with the same money. It records amounts, services, request
// ids and transactions — never key material.
//
// Entry statuses: reserved (about to be signed/sent), spent (Bacon delivered and settled),
// uncertain (sent, outcome unknown: treated as spent), released (Bacon refused it before taking
// any money). Everything but released counts against the limits.

import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

const DAY_MS = 24 * 60 * 60 * 1000;
const KEEP_MS = 30 * DAY_MS;
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 10_000;
export const REPEAT_WINDOW_MS = 10 * 60 * 1000;
const COUNTS = new Set(['reserved', 'spent', 'uncertain']);

export class LedgerError extends Error {}

export class Ledger {
    constructor(dir, { now = () => Date.now() } = {}) {
        this.dir = dir;
        this.file = join(dir, 'spend-ledger.json');
        this.lockFile = join(dir, 'spend-ledger.lock');
        this.now = now;
    }

    /** Total that counts against the daily ceiling on this network, in atomic units. */
    async spentLastDay(network) {
        return this.#locked((data) => sumSince(data.entries, network, this.now() - DAY_MS));
    }

    /** The latest purchase of the same request within the repeat window that was not refused, or null. */
    async recent(network, fingerprint) {
        return this.#locked((data) => {
            const now = this.now();
            return data.entries.filter((e) => e.network === network && e.fingerprint === fingerprint
                && COUNTS.has(e.status) && now - e.created_at < REPEAT_WINDOW_MS).pop() ?? null;
        });
    }

    /**
     * Reserves `amount` for one purchase, or says why not, in one locked step:
     * an earlier purchase of the same thing (unless allowRepeat), then the daily ceiling, then
     * `sessionCheck` (the caller's per-process ceiling).
     */
    async reserve({ network, capability, fingerprint, amount, perDay, allowRepeat, sessionCheck }) {
        return this.#locked((data) => {
            const now = this.now();
            const previous = data.entries.filter((e) => e.network === network && e.fingerprint === fingerprint
                && COUNTS.has(e.status) && now - e.created_at < REPEAT_WINDOW_MS).pop();
            if (previous && !allowRepeat) {
                return { duplicate: previous };
            }
            const spentToday = sumSince(data.entries, network, now - DAY_MS);
            if (spentToday + amount > perDay) {
                return { refused: 'day', spentToday };
            }
            const sessionProblem = sessionCheck(amount);
            if (sessionProblem) {
                return { refused: 'session', detail: sessionProblem };
            }
            const entry = { id: randomUUID(), network, capability, fingerprint, amount: amount.toString(), status: 'reserved', created_at: now, updated_at: now };
            data.entries.push(entry);
            return { entry, write: true };
        });
    }

    /** Records what happened to a reservation: spent, uncertain or released, with its details. */
    async update(id, status, details = {}) {
        return this.#locked((data) => {
            const entry = data.entries.find((e) => e.id === id);
            if (!entry) {
                throw new LedgerError(`Ledger entry ${id} is missing.`);
            }
            Object.assign(entry, details, { status, updated_at: this.now() });
            return { entry, write: true };
        });
    }

    #locked(fn) {
        mkdirSync(this.dir, { recursive: true });
        return this.#withLock(() => {
            const data = this.#read();
            const result = fn(data);
            if (result?.write) {
                const cutoff = this.now() - KEEP_MS;
                data.entries = data.entries.filter((e) => e.created_at >= cutoff);
                // A JSON result is kept only as long as a repeat could hand it back.
                for (const e of data.entries) {
                    if (e.result !== undefined && this.now() - e.created_at >= REPEAT_WINDOW_MS) {
                        delete e.result;
                    }
                }
                const temp = `${this.file}.${process.pid}.tmp`;
                writeFileSync(temp, JSON.stringify(data, null, 1));
                renameSync(temp, this.file);
                delete result.write;
            }
            return result;
        });
    }

    #read() {
        let text;
        try {
            text = readFileSync(this.file, 'utf8');
        } catch (error) {
            if (error.code === 'ENOENT') {
                return { version: 1, entries: [] };
            }
            throw new LedgerError(`The spend ledger ${this.file} cannot be read (${error.code}). No payment is made while it is unreadable.`);
        }
        try {
            const data = JSON.parse(text);
            if (data?.version === 1 && Array.isArray(data.entries)) {
                return data;
            }
        } catch {
            // fall through
        }
        throw new LedgerError(`The spend ledger ${this.file} is damaged. No payment is made until it is repaired or removed (removing it resets the daily limit).`);
    }

    async #withLock(fn) {
        const started = Date.now();
        for (;;) {
            try {
                closeSync(openSync(this.lockFile, 'wx'));
                break;
            } catch (error) {
                if (error.code !== 'EEXIST') {
                    throw new LedgerError(`The spend ledger lock ${this.lockFile} cannot be created (${error.code}).`);
                }
                try {
                    if (Date.now() - statSync(this.lockFile).mtimeMs > LOCK_STALE_MS) {
                        rmSync(this.lockFile, { force: true });
                        continue;
                    }
                } catch {
                    continue;
                }
                if (Date.now() - started > LOCK_WAIT_MS) {
                    throw new LedgerError(`The spend ledger is locked by another process (${this.lockFile}).`);
                }
                await new Promise((resolve) => setTimeout(resolve, 20));
            }
        }
        try {
            return fn();
        } finally {
            rmSync(this.lockFile, { force: true });
        }
    }
}

function sumSince(entries, network, since) {
    return entries.reduce((total, e) => (e.network === network && COUNTS.has(e.status) && e.created_at > since ? total + BigInt(e.amount) : total), 0n);
}
