// USDC amounts as integer atomic units (6 decimals) in BigInt: never floating point.

export const USDC_DECIMALS = 6;

/** "0.5" → 500000n. Refuses anything that is not a plain non-negative decimal with at most 6 places. */
export function parseUsdc(text, what = 'amount') {
    const value = String(text ?? '').trim();
    const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(value);
    if (!match) {
        throw new Error(`${what} must be a USDC amount such as 0.50 (got "${value}").`);
    }
    return BigInt(match[1]) * 10n ** 6n + BigInt((match[2] ?? '').padEnd(6, '0'));
}

/** 200000n → "0.2". */
export function formatUsdc(atomic) {
    const amount = BigInt(atomic);
    const whole = amount / 10n ** 6n;
    const fraction = (amount % 10n ** 6n).toString().padStart(6, '0').replace(/0+$/, '');
    return fraction === '' ? whole.toString() : `${whole}.${fraction}`;
}

/** A string of decimal digits from the wire → BigInt, or null when it is anything else. */
export function atomicFromWire(value) {
    return typeof value === 'string' && /^\d{1,30}$/.test(value) ? BigInt(value) : null;
}
