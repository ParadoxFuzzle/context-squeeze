export const DEFAULT_CONFIG = {
    keepRecentTurns: 6,
    compressionRatio: 0.3,
    minTurnsBeforeCompression: 10,
    targetTokenBudget: 0,
    anchorPreserve: true,
    minMessageChars: 400,
    debugStatsFile: "",
};
export const CONFIG_JSON_SCHEMA = {
    type: "object",
    properties: {
        keepRecentTurns: {
            type: "integer",
            minimum: 1,
            maximum: 200,
            default: 6,
            description: "Number of most recent messages kept verbatim.",
        },
        compressionRatio: {
            type: "number",
            minimum: 0.05,
            maximum: 0.95,
            default: 0.3,
            description: "Target size of compressed cold messages as a fraction of their original size.",
        },
        minTurnsBeforeCompression: {
            type: "integer",
            minimum: 2,
            maximum: 1000,
            default: 10,
            description: "Do not compress histories shorter than this many messages.",
        },
        targetTokenBudget: {
            type: "integer",
            minimum: 0,
            maximum: 2_000_000,
            default: 0,
            description: "Additional hard prompt budget in tokens. 0 uses the host budget only.",
        },
        anchorPreserve: {
            type: "boolean",
            default: true,
            description: "Preserve paths, commands, addresses, ticket ids, and similar facts as anchors.",
        },
        minMessageChars: {
            type: "integer",
            minimum: 0,
            maximum: 8000,
            default: 400,
            description: "Cold messages shorter than this stay verbatim.",
        },
        debugStatsFile: {
            type: "string",
            default: "",
            description: "Optional absolute path for append-only JSONL compression stats.",
        },
    },
    additionalProperties: false,
};
export function resolveConfig(raw, overrides = {}) {
    const cfg = raw ?? {};
    return {
        keepRecentTurns: clampInt(num(cfg.keepRecentTurns, DEFAULT_CONFIG.keepRecentTurns), 1, 200),
        compressionRatio: clamp(num(overrides.compressionRatio ?? cfg.compressionRatio, DEFAULT_CONFIG.compressionRatio), 0.05, 0.95),
        minTurnsBeforeCompression: clampInt(num(cfg.minTurnsBeforeCompression, DEFAULT_CONFIG.minTurnsBeforeCompression), 2, 1000),
        targetTokenBudget: clampInt(num(overrides.targetTokenBudget ?? cfg.targetTokenBudget, DEFAULT_CONFIG.targetTokenBudget), 0, 2_000_000),
        anchorPreserve: cfg.anchorPreserve !== false,
        minMessageChars: clampInt(num(cfg.minMessageChars, DEFAULT_CONFIG.minMessageChars), 0, 8000),
        debugStatsFile: typeof cfg.debugStatsFile === "string" ? cfg.debugStatsFile.trim() : "",
    };
}
function validateConfig(value) {
    if (value == null)
        return { ok: true, value: {} };
    if (typeof value !== "object" || Array.isArray(value)) {
        return { ok: false, errors: ["config must be an object"] };
    }
    const input = value;
    const errors = [];
    const allowed = new Set(Object.keys(CONFIG_JSON_SCHEMA.properties));
    for (const key of Object.keys(input)) {
        if (!allowed.has(key))
            errors.push(`unknown config key: ${key}`);
    }
    integerInRange(input, "keepRecentTurns", 1, 200, errors);
    numberInRange(input, "compressionRatio", 0.05, 0.95, errors);
    integerInRange(input, "minTurnsBeforeCompression", 2, 1000, errors);
    integerInRange(input, "targetTokenBudget", 0, 2_000_000, errors);
    integerInRange(input, "minMessageChars", 0, 8000, errors);
    if (input.anchorPreserve !== undefined && typeof input.anchorPreserve !== "boolean") {
        errors.push("anchorPreserve must be a boolean");
    }
    if (input.debugStatsFile !== undefined && typeof input.debugStatsFile !== "string") {
        errors.push("debugStatsFile must be a string");
    }
    return errors.length > 0 ? { ok: false, errors } : { ok: true, value: input };
}
export const configSchema = {
    jsonSchema: CONFIG_JSON_SCHEMA,
    validate: validateConfig,
    safeParse(value) {
        const result = validateConfig(value);
        return result.ok
            ? { success: true, data: result.value }
            : { success: false, error: { issues: result.errors.map((message) => ({ path: [], message })) } };
    },
};
function integerInRange(input, key, min, max, errors) {
    const value = input[key];
    if (value === undefined)
        return;
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
        errors.push(`${key} must be an integer between ${min} and ${max}`);
    }
}
function numberInRange(input, key, min, max, errors) {
    const value = input[key];
    if (value === undefined)
        return;
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
        errors.push(`${key} must be a number between ${min} and ${max}`);
    }
}
function num(value, fallback) {
    const parsed = typeof value === "number" ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}
function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}
function clampInt(value, min, max) {
    return Math.round(clamp(value, min, max));
}
