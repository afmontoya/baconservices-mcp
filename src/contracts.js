// The capability contracts this version of the package understands.
//
// The live catalog decides what is FOR SALE (and at what price); this table decides what this
// package will EXECUTE. A capability becomes a paid tool only when its catalog entry matches one
// of these contracts exactly. A contract is the capability id, its behaviour `version`, its
// `input_version` and `output_version`, an input type (one image, or one web page URL) with the
// same option names, types and bounds, an output (an artifact file of one MIME type, or a JSON
// result), synchronous execution, and declared limits. Anything else — a new capability, a new
// version, a changed schema, a catalog contract_version this package does not know — is still
// shown by list_services, but is not executable until a package release that knows it.

/** Catalog document shapes (`contract_version`) this package understands. */
export const SUPPORTED_CATALOG_VERSIONS = [1];

export const IMAGE_FORMATS = ['image/png', 'image/jpeg', 'image/webp'];

const INPUTS = {
    image: { image_url: { type: 'string' }, image_base64: { type: 'string' } },
    url: { url: { type: 'string' } },
};

export const CONTRACTS = [
    {
        tool: 'remove_background',
        id: 'remove-background',
        version: 1,
        inputVersion: 1,
        outputVersion: 1,
        // Sold before catalog contract fields existed: also matches a catalog without them.
        legacy: true,
        title: 'Remove background',
        summary: 'Removes the background from one photo and returns the subject on a transparent background as a PNG, at the photo\'s own size.',
        input: 'image',
        options: {},
        output: { kind: 'artifact', mime: 'image/png' },
        execution: 'sync',
    },
    {
        tool: 'optimize_image',
        id: 'web-image-optimizer',
        version: 1,
        inputVersion: 1,
        outputVersion: 1,
        legacy: true,
        title: 'Optimize image for the web',
        summary: 'Resizes one image so its longest side is at most max_width pixels (never enlarging it) and encodes it as WebP at the given quality. Transparency is kept; metadata is not carried over.',
        input: 'image',
        options: {
            max_width: { type: 'integer', minimum: 64, maximum: 4096, default: 1600, description: 'Longest side of the output, in pixels.' },
            quality: { type: 'integer', minimum: 40, maximum: 95, default: 80, description: 'WebP quality.' },
        },
        output: { kind: 'artifact', mime: 'image/webp' },
        execution: 'sync',
    },
    {
        tool: 'image_palette',
        id: 'image-palette',
        version: 1,
        inputVersion: 1,
        outputVersion: 1,
        title: 'Image palette',
        summary: 'Returns the colours one image is mostly made of, as JSON: up to count colours, most common first, each a hex value with its share of the image and whether it is a neutral.',
        input: 'image',
        options: {
            count: { type: 'integer', minimum: 1, maximum: 12, default: 6, description: 'The most colours to return.' },
            include_neutrals: { type: 'boolean', default: true, description: 'Count near-whites, near-blacks and greys too.' },
        },
        output: { kind: 'json', mime: 'application/json' },
        execution: 'sync',
    },
    {
        tool: 'brand_from_url',
        id: 'brand-from-url',
        version: 1,
        inputVersion: 1,
        outputVersion: 1,
        title: 'Brand from URL',
        summary: 'Reads one public web page and returns the brand it publishes about itself, as JSON: name, description, logo image URLs, colours, fonts and social profiles. No JavaScript runs; robots.txt is respected.',
        input: 'url',
        options: {},
        output: { kind: 'json', mime: 'application/json' },
        execution: 'sync',
    },
];

export function contractId(id, version) {
    return `${id}@${version}`;
}

export function contractForTool(tool) {
    return CONTRACTS.find((c) => c.tool === tool) ?? null;
}

export function contractForEntry(entry) {
    return CONTRACTS.find((c) => c.id === entry?.id) ?? null;
}

/**
 * Whether a live catalog entry matches its contract, and every reason it does not.
 * `expected`: the endpoint URL, the network's USDC address, and the catalog's contract_version
 * (undefined for a catalog published before contract fields existed).
 */
export function checkEntry(entry, contract, expected) {
    const reasons = [];
    if (!contract) {
        return [`this version of baconservices-mcp does not know the contract ${contractId(entry?.id, entry?.version)}; update the package to use it`];
    }
    const legacyCatalog = expected.catalogVersion === undefined;
    if (!legacyCatalog && !SUPPORTED_CATALOG_VERSIONS.includes(expected.catalogVersion)) {
        return [`the catalog's contract_version ${JSON.stringify(expected.catalogVersion)} is not one this package understands (${SUPPORTED_CATALOG_VERSIONS.join(', ')}); update the package`];
    }
    if (legacyCatalog && !contract.legacy) {
        return ['the catalog does not declare contract versions, which this service needs'];
    }

    if (entry.version !== contract.version) {
        reasons.push(`Bacon offers ${contractId(entry.id, entry.version)}, this package understands ${contractId(contract.id, contract.version)}; update the package`);
    }
    // A legacy catalog has no contract fields: its two services are input/output version 1 by definition.
    const inputVersion = legacyCatalog ? (entry.input_version ?? 1) : entry.input_version;
    const outputVersion = legacyCatalog ? (entry.output_version ?? 1) : entry.output_version;
    if (inputVersion !== contract.inputVersion) {
        reasons.push(`input_version is ${JSON.stringify(entry.input_version)}, this package understands ${contract.inputVersion}`);
    }
    if (outputVersion !== contract.outputVersion) {
        reasons.push(`output_version is ${JSON.stringify(entry.output_version)}, this package understands ${contract.outputVersion}`);
    }
    if ((entry.execution ?? 'sync') !== contract.execution) {
        reasons.push(`execution is "${entry.execution}", expected "${contract.execution}"`);
    }

    const output = entry.output ?? {};
    const kind = legacyCatalog ? (output.kind ?? 'artifact') : output.kind;
    if (kind !== contract.output.kind || output.mime !== contract.output.mime) {
        reasons.push(`output is ${kind ?? 'undeclared'} ${output.mime ?? ''}, expected ${contract.output.kind} ${contract.output.mime}`);
    }
    if (!legacyCatalog && (typeof output.schema !== 'object' || output.schema === null)) {
        reasons.push('no output schema is declared');
    }

    const input = entry.input ?? {};
    const expectedProperties = { ...INPUTS[contract.input], ...contract.options };
    const properties = input.properties ?? {};
    if (input.type !== 'object' || input.additionalProperties !== false) {
        reasons.push('input schema is not a closed object');
    }
    const names = Object.keys(properties).sort().join(',');
    if (names !== Object.keys(expectedProperties).sort().join(',')) {
        reasons.push(`input properties are [${names}], expected [${Object.keys(expectedProperties).sort().join(',')}]`);
    } else {
        for (const [name, want] of Object.entries(expectedProperties)) {
            for (const key of ['type', 'minimum', 'maximum', 'default']) {
                if (want[key] !== properties[name][key]) {
                    reasons.push(`input ${name}.${key} is ${JSON.stringify(properties[name][key])}, expected ${JSON.stringify(want[key])}`);
                }
            }
        }
    }
    if (contract.input === 'url' && !(Array.isArray(input.required) && input.required.includes('url'))) {
        reasons.push('input does not require url');
    }

    const price = entry.price ?? {};
    if (typeof price.amount !== 'string' || !/^\d{1,30}$/.test(price.amount)) {
        reasons.push('price amount is missing or not atomic units');
    }
    if (price.symbol !== 'USDC' || price.decimals !== 6 || typeof price.asset !== 'string' || price.asset.toLowerCase() !== expected.usdc.toLowerCase()) {
        reasons.push('price is not in USDC on the configured network');
    }
    if (entry.endpoint?.method !== 'POST' || entry.endpoint?.url !== expected.endpoint) {
        reasons.push(`endpoint is ${entry.endpoint?.method} ${entry.endpoint?.url}, expected POST ${expected.endpoint}`);
    }

    const limits = entry.limits ?? {};
    const positive = (value) => Number.isInteger(value) && value > 0;
    if (!positive(limits.max_bytes)) {
        reasons.push('no maximum input size is declared');
    }
    if (!Array.isArray(limits.formats) || limits.formats.length === 0
        || (contract.input === 'image' && limits.formats.some((f) => !IMAGE_FORMATS.includes(f)))) {
        reasons.push(`input formats are missing${contract.input === 'image' ? ' or not PNG/JPEG/WebP' : ''}`);
    }
    if (!legacyCatalog && !positive(limits.max_request_bytes)) {
        reasons.push('no maximum request size is declared');
    }
    if (contract.output.kind === 'json' && !positive(limits.max_response_bytes)) {
        reasons.push('no maximum response size is declared for a JSON result');
    }
    if (limits.max_seconds !== undefined && !positive(limits.max_seconds)) {
        reasons.push('max_seconds is not a positive whole number');
    }

    return reasons;
}
