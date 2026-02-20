export type TextCandidateCollectorOptions = {
    preferredKeys?: readonly string[];
    skipKeys?: ReadonlySet<string>;
    maxDepth?: number;
    maxCandidates?: number;
    normalize?: (value: string) => string;
    preserveWhitespace?: boolean;
    shouldSkipEntry?: (entry: { key: string; value: unknown; parent: Record<string, unknown> }) => boolean;
    isLikelyText: (value: string) => boolean;
};

const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_CANDIDATES = 120;

const shouldStopCollection = (
    depth: number,
    out: string[],
    options: Required<Pick<TextCandidateCollectorOptions, 'maxDepth' | 'maxCandidates'>>,
) => depth > options.maxDepth || out.length >= options.maxCandidates;

const collectStringNode = (
    node: string,
    out: string[],
    options: Omit<TextCandidateCollectorOptions, 'maxDepth' | 'maxCandidates'>,
) => {
    const normalized = options.normalize ? options.normalize(node) : node;
    if (!options.isLikelyText(normalized)) {
        return;
    }
    out.push(options.preserveWhitespace ? normalized : normalized.trim());
};

const collectArrayNode = (
    node: unknown[],
    out: string[],
    depth: number,
    options: Required<Pick<TextCandidateCollectorOptions, 'maxDepth' | 'maxCandidates'>> &
        Omit<TextCandidateCollectorOptions, 'maxDepth' | 'maxCandidates'>,
) => {
    for (const child of node) {
        collectNode(child, out, depth + 1, options);
        if (out.length >= options.maxCandidates) {
            break;
        }
    }
};

const shouldSkipObjectEntry = (
    node: Record<string, unknown>,
    key: string,
    value: unknown,
    preferredSet: Set<string> | null,
    options: Required<Pick<TextCandidateCollectorOptions, 'maxDepth' | 'maxCandidates'>> &
        Omit<TextCandidateCollectorOptions, 'maxDepth' | 'maxCandidates'>,
) => {
    if (options.skipKeys?.has(key)) {
        return true;
    }
    if (preferredSet?.has(key)) {
        return true;
    }
    if (options.shouldSkipEntry?.({ key, value, parent: node })) {
        return true;
    }
    return false;
};

const collectObjectNode = (
    node: Record<string, unknown>,
    out: string[],
    depth: number,
    options: Required<Pick<TextCandidateCollectorOptions, 'maxDepth' | 'maxCandidates'>> &
        Omit<TextCandidateCollectorOptions, 'maxDepth' | 'maxCandidates'>,
) => {
    const preferredSet = options.preferredKeys ? new Set(options.preferredKeys) : null;

    if (options.preferredKeys) {
        for (const key of options.preferredKeys) {
            if (key in node) {
                collectNode(node[key], out, depth + 1, options);
            }
        }
    }

    for (const [key, value] of Object.entries(node)) {
        if (shouldSkipObjectEntry(node, key, value, preferredSet, options)) {
            continue;
        }
        collectNode(value, out, depth + 1, options);
        if (out.length >= options.maxCandidates) {
            break;
        }
    }
};

const collectNode = (
    node: unknown,
    out: string[],
    depth: number,
    options: Required<Pick<TextCandidateCollectorOptions, 'maxDepth' | 'maxCandidates'>> &
        Omit<TextCandidateCollectorOptions, 'maxDepth' | 'maxCandidates'>,
) => {
    if (shouldStopCollection(depth, out, options)) {
        return;
    }

    if (typeof node === 'string') {
        collectStringNode(node, out, options);
        return;
    }

    if (!node || typeof node !== 'object') {
        return;
    }

    if (Array.isArray(node)) {
        collectArrayNode(node, out, depth, options);
        return;
    }

    collectObjectNode(node as Record<string, unknown>, out, depth, options);
};

export const collectLikelyTextCandidates = (node: unknown, options: TextCandidateCollectorOptions): string[] => {
    const out: string[] = [];
    collectNode(node, out, 0, {
        ...options,
        maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
        maxCandidates: options.maxCandidates ?? DEFAULT_MAX_CANDIDATES,
    });
    return out;
};
