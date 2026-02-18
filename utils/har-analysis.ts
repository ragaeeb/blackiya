import type {
    Har,
    Content as HarContent,
    Entry as HarEntrySpec,
    Header as HarHeaderSpec,
    Request as HarRequestSpec,
    Response as HarResponseSpec,
} from 'har-format';

type HarHeader = Partial<HarHeaderSpec>;
type HarRequest = Partial<HarRequestSpec>;
type HarResponseContent = Partial<HarContent>;
type HarResponse = Partial<HarResponseSpec> & { content?: HarResponseContent };
type HarEntry = Partial<Omit<HarEntrySpec, 'request' | 'response'>> & {
    request?: HarRequest;
    response?: HarResponse;
};
type HarRoot = Partial<Har> & {
    log?: Partial<Har['log']> & {
        entries?: HarEntry[];
    };
};

export type HarAnalysisOptions = {
    hints?: string[];
    hostFilter?: string[];
    maxBodyChars?: number;
    maxMatchesPerHint?: number;
    snippetRadius?: number;
    sourceFile?: string;
};

export type HarHintMatch = {
    hint: string;
    phase: 'request' | 'response';
    entryIndex: number;
    startedDateTime: string | null;
    method: string;
    host: string;
    path: string;
    url: string;
    snippet: string;
};

export type HarTimelineEvent = {
    entryIndex: number;
    startedDateTime: string | null;
    method: string;
    status: number | null;
    host: string;
    path: string;
    queryKeys: string[];
    url: string;
    mimeType: string | null;
    durationMs: number | null;
    requestBodyBytes: number;
    responseBodyBytes: number;
    streamLikely: boolean;
    reasoningSignals: string[];
    hintMatches: string[];
    requestHeaders: Record<string, string>;
    responseHeaders: Record<string, string>;
};

export type HarEndpointSummary = {
    method: string;
    host: string;
    path: string;
    count: number;
    statuses: number[];
    mimeTypes: string[];
    queryKeys: string[];
    streamLikelyCount: number;
    reasoningSignalCount: number;
    hintMatchCount: number;
};

export type HarAnalysisResult = {
    generatedAt: string;
    sourceFile: string | null;
    hints: string[];
    hostFilter: string[];
    stats: {
        totalEntries: number;
        entriesScanned: number;
        entriesFilteredOut: number;
        timelineEvents: number;
        endpointCount: number;
        streamLikelyEvents: number;
        reasoningSignalEvents: number;
        hintMatches: number;
    };
    likelyStreamingEndpoints: HarEndpointSummary[];
    endpointSummary: HarEndpointSummary[];
    hintMatches: HarHintMatch[];
    timeline: HarTimelineEvent[];
};

type HintLookup = {
    hint: string;
    normalized: string;
};

const DEFAULT_MAX_BODY_CHARS = 300_000;
const DEFAULT_MAX_MATCHES_PER_HINT = 60;
const DEFAULT_SNIPPET_RADIUS = 120;

const SENSITIVE_KEYWORDS = ['auth', 'token', 'cookie', 'session', 'secret', 'key', 'signature'];

const INTERESTING_HEADERS = new Set([
    'accept',
    'authorization',
    'content-type',
    'cookie',
    'set-cookie',
    'transfer-encoding',
    'x-requested-with',
    'x-client-data',
]);

const STREAM_PATH_PATTERNS = [
    /reconnect-response/i,
    /load-responses/i,
    /conversations\/new/i,
    /stream/i,
    /events/i,
    /responses?/i,
    /completion/i,
    /chat\/api/i,
];

const STREAM_MIME_PATTERNS = [/event-stream/i, /ndjson/i, /jsonl/i, /octet-stream/i];

const REASONING_SIGNAL_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
    { label: 'isThinking', pattern: /\bisthinking\b/i },
    { label: 'thinking_trace', pattern: /\bthinking_trace\b/i },
    { label: 'tool_usage_card', pattern: /\btool_usage_card\b/i },
    { label: 'agents thinking', pattern: /agents thinking/i },
    { label: 'reasoning', pattern: /\breasoning\b/i },
    { label: 'deepsearch_headers', pattern: /\bdeepsearch_headers\b/i },
];

type SanitizedUrlParts = {
    url: string;
    host: string;
    path: string;
    queryKeys: string[];
};

const normalizeHints = (hints: string[]): HintLookup[] => {
    const seen = new Set<string>();
    const normalizedHints: HintLookup[] = [];
    for (const hint of hints) {
        const trimmed = hint.trim();
        if (!trimmed) {
            continue;
        }
        const key = trimmed.toLowerCase();
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        normalizedHints.push({ hint: trimmed, normalized: key });
    }
    return normalizedHints;
};

const isSensitive = (key: string): boolean => {
    const normalized = key.toLowerCase();
    return SENSITIVE_KEYWORDS.some((word) => normalized.includes(word));
};

const sanitizeUrl = (rawUrl: string): SanitizedUrlParts => {
    try {
        const parsed = new URL(rawUrl);
        const queryKeys: string[] = [];
        for (const [key, value] of parsed.searchParams.entries()) {
            queryKeys.push(key);
            if (isSensitive(key)) {
                parsed.searchParams.set(key, '[REDACTED]');
                continue;
            }
            if (value.length > 180) {
                parsed.searchParams.set(key, `${value.slice(0, 180)}...[TRUNCATED]`);
            }
        }
        return {
            url: parsed.toString(),
            host: parsed.hostname,
            path: parsed.pathname,
            queryKeys: Array.from(new Set(queryKeys)),
        };
    } catch {
        return {
            url: rawUrl,
            host: '',
            path: rawUrl,
            queryKeys: [],
        };
    }
};

const sanitizeHeaders = (headers?: HarHeader[]): Record<string, string> => {
    if (!Array.isArray(headers) || headers.length === 0) {
        return {};
    }

    const output: Record<string, string> = {};
    for (const header of headers) {
        if (!header?.name) {
            continue;
        }
        const headerName = header.name.toLowerCase();
        const shouldKeep = INTERESTING_HEADERS.has(headerName) || headerName.startsWith('x-');
        if (!shouldKeep) {
            continue;
        }
        const rawValue = String(header.value ?? '');
        if (isSensitive(headerName)) {
            output[headerName] = '[REDACTED]';
            continue;
        }
        output[headerName] = rawValue.length > 240 ? `${rawValue.slice(0, 240)}...[TRUNCATED]` : rawValue;
    }

    return output;
};

const decodeResponseBody = (content?: HarResponseContent): string => {
    if (!content?.text) {
        return '';
    }
    if (content.encoding === 'base64') {
        try {
            return Buffer.from(content.text, 'base64').toString('utf8');
        } catch {
            return '';
        }
    }
    return content.text;
};

const clipBody = (text: string, maxChars: number): string => {
    if (text.length <= maxChars) {
        return text;
    }
    return text.slice(0, maxChars);
};

const detectReasoningSignals = (text: string): string[] => {
    if (!text) {
        return [];
    }
    return REASONING_SIGNAL_PATTERNS.filter((item) => item.pattern.test(text)).map((item) => item.label);
};

const looksLikeNdjson = (text: string): boolean => {
    if (!text) {
        return false;
    }
    const lines = text.split('\n').map((line) => line.trim());
    if (lines.length < 2) {
        return false;
    }
    let jsonishLines = 0;
    for (const line of lines) {
        if (!line) {
            continue;
        }
        if (line.startsWith('{') || line.startsWith('data: {')) {
            jsonishLines += 1;
        }
        if (jsonishLines >= 2) {
            return true;
        }
    }
    return false;
};

const isStreamLikely = (
    path: string,
    mimeType: string,
    responseBody: string,
    responseHeaders: Record<string, string>,
): boolean => {
    if (STREAM_PATH_PATTERNS.some((pattern) => pattern.test(path))) {
        return true;
    }
    if (STREAM_MIME_PATTERNS.some((pattern) => pattern.test(mimeType))) {
        return true;
    }
    if ((responseHeaders['transfer-encoding'] ?? '').toLowerCase().includes('chunked')) {
        return true;
    }
    return looksLikeNdjson(responseBody);
};

const buildSnippet = (text: string, index: number, length: number, radius: number): string => {
    const start = Math.max(0, index - radius);
    const end = Math.min(text.length, index + length + radius);
    const prefix = start > 0 ? '...' : '';
    const suffix = end < text.length ? '...' : '';
    return `${prefix}${text.slice(start, end)}${suffix}`;
};

const collectHintMatches = (
    body: string,
    phase: 'request' | 'response',
    event: HarTimelineEvent,
    entryIndex: number,
    hints: HintLookup[],
    radius: number,
    maxMatchesPerHint: number,
    matchCounters: Map<string, number>,
): HarHintMatch[] => {
    if (!body || hints.length === 0) {
        return [];
    }

    const matches: HarHintMatch[] = [];
    const normalizedBody = body.toLowerCase();

    for (const hint of hints) {
        const currentCount = matchCounters.get(hint.hint) ?? 0;
        if (currentCount >= maxMatchesPerHint) {
            continue;
        }

        let from = 0;
        while (from < normalizedBody.length) {
            const index = normalizedBody.indexOf(hint.normalized, from);
            if (index === -1) {
                break;
            }

            matches.push({
                hint: hint.hint,
                phase,
                entryIndex,
                startedDateTime: event.startedDateTime,
                method: event.method,
                host: event.host,
                path: event.path,
                url: event.url,
                snippet: buildSnippet(body, index, hint.hint.length, radius),
            });

            const updatedCount = (matchCounters.get(hint.hint) ?? 0) + 1;
            matchCounters.set(hint.hint, updatedCount);
            if (updatedCount >= maxMatchesPerHint) {
                break;
            }

            from = index + hint.normalized.length;
        }
    }

    return matches;
};

const createEndpointKey = (method: string, host: string, path: string): string => `${method} ${host}${path}`;

const parseHarEntries = (rawHar: string): HarEntry[] => {
    const parsed = JSON.parse(rawHar) as HarRoot;
    const entries = parsed?.log?.entries;
    if (!Array.isArray(entries)) {
        throw new Error('Invalid HAR: expected log.entries to be an array');
    }
    return entries;
};

export const analyzeHarContent = (rawHar: string, options: HarAnalysisOptions = {}): HarAnalysisResult => {
    const entries = parseHarEntries(rawHar);

    const maxBodyChars = options.maxBodyChars ?? DEFAULT_MAX_BODY_CHARS;
    const maxMatchesPerHint = options.maxMatchesPerHint ?? DEFAULT_MAX_MATCHES_PER_HINT;
    const snippetRadius = options.snippetRadius ?? DEFAULT_SNIPPET_RADIUS;
    const hints = normalizeHints(options.hints ?? []);
    const hostFilter = Array.from(
        new Set((options.hostFilter ?? []).map((host) => host.trim().toLowerCase()).filter(Boolean)),
    );

    const endpointMap = new Map<
        string,
        {
            method: string;
            host: string;
            path: string;
            statuses: Set<number>;
            mimeTypes: Set<string>;
            queryKeys: Set<string>;
            count: number;
            streamLikelyCount: number;
            reasoningSignalCount: number;
            hintMatchCount: number;
        }
    >();

    const timeline: HarTimelineEvent[] = [];
    const hintMatches: HarHintMatch[] = [];
    const hintCounters = new Map<string, number>();

    let filteredOut = 0;
    let streamLikelyEvents = 0;
    let reasoningSignalEvents = 0;

    entries.forEach((entry, entryIndex) => {
        const method = String(entry.request?.method ?? 'GET').toUpperCase();
        const rawUrl = String(entry.request?.url ?? '');
        if (!rawUrl) {
            filteredOut += 1;
            return;
        }

        const urlParts = sanitizeUrl(rawUrl);
        if (hostFilter.length > 0 && !hostFilter.includes(urlParts.host.toLowerCase())) {
            filteredOut += 1;
            return;
        }

        const requestBodyRaw = String(entry.request?.postData?.text ?? '');
        const responseBodyRaw = decodeResponseBody(entry.response?.content);
        const requestBody = clipBody(requestBodyRaw, maxBodyChars);
        const responseBody = clipBody(responseBodyRaw, maxBodyChars);
        const responseHeaders = sanitizeHeaders(entry.response?.headers);
        const requestHeaders = sanitizeHeaders(entry.request?.headers);
        const mimeType = String(
            entry.response?.content?.mimeType ??
                entry.response?.headers?.find((h) => h.name?.toLowerCase() === 'content-type')?.value ??
                '',
        ).toLowerCase();
        const reasoningSignals = detectReasoningSignals(responseBody);
        const streamLikely = isStreamLikely(urlParts.path, mimeType, responseBody, responseHeaders);

        const event: HarTimelineEvent = {
            entryIndex,
            startedDateTime: entry.startedDateTime ?? null,
            method,
            status: Number.isFinite(entry.response?.status) ? Number(entry.response?.status) : null,
            host: urlParts.host,
            path: urlParts.path,
            queryKeys: urlParts.queryKeys,
            url: urlParts.url,
            mimeType: mimeType || null,
            durationMs: Number.isFinite(entry.time) ? Number(entry.time) : null,
            requestBodyBytes: requestBodyRaw.length,
            responseBodyBytes: responseBodyRaw.length,
            streamLikely,
            reasoningSignals,
            hintMatches: [],
            requestHeaders,
            responseHeaders,
        };

        const requestMatches = collectHintMatches(
            requestBody,
            'request',
            event,
            entryIndex,
            hints,
            snippetRadius,
            maxMatchesPerHint,
            hintCounters,
        );
        const responseMatches = collectHintMatches(
            responseBody,
            'response',
            event,
            entryIndex,
            hints,
            snippetRadius,
            maxMatchesPerHint,
            hintCounters,
        );
        const allMatches = requestMatches.concat(responseMatches);
        event.hintMatches = Array.from(new Set(allMatches.map((item) => item.hint)));

        hintMatches.push(...allMatches);

        if (streamLikely) {
            streamLikelyEvents += 1;
        }
        if (reasoningSignals.length > 0) {
            reasoningSignalEvents += 1;
        }

        timeline.push(event);

        const endpointKey = createEndpointKey(method, urlParts.host, urlParts.path);
        const endpoint = endpointMap.get(endpointKey) ?? {
            method,
            host: urlParts.host,
            path: urlParts.path,
            statuses: new Set<number>(),
            mimeTypes: new Set<string>(),
            queryKeys: new Set<string>(),
            count: 0,
            streamLikelyCount: 0,
            reasoningSignalCount: 0,
            hintMatchCount: 0,
        };

        endpoint.count += 1;
        if (event.status !== null) {
            endpoint.statuses.add(event.status);
        }
        if (event.mimeType) {
            endpoint.mimeTypes.add(event.mimeType);
        }
        for (const key of event.queryKeys) {
            endpoint.queryKeys.add(key);
        }
        if (event.streamLikely) {
            endpoint.streamLikelyCount += 1;
        }
        if (event.reasoningSignals.length > 0) {
            endpoint.reasoningSignalCount += 1;
        }
        endpoint.hintMatchCount += event.hintMatches.length;

        endpointMap.set(endpointKey, endpoint);
    });

    timeline.sort((a, b) => {
        if (!a.startedDateTime && !b.startedDateTime) {
            return a.entryIndex - b.entryIndex;
        }
        if (!a.startedDateTime) {
            return 1;
        }
        if (!b.startedDateTime) {
            return -1;
        }
        return a.startedDateTime.localeCompare(b.startedDateTime);
    });

    const endpointSummary: HarEndpointSummary[] = Array.from(endpointMap.values())
        .map((endpoint) => ({
            method: endpoint.method,
            host: endpoint.host,
            path: endpoint.path,
            count: endpoint.count,
            statuses: Array.from(endpoint.statuses).sort((a, b) => a - b),
            mimeTypes: Array.from(endpoint.mimeTypes).sort(),
            queryKeys: Array.from(endpoint.queryKeys).sort(),
            streamLikelyCount: endpoint.streamLikelyCount,
            reasoningSignalCount: endpoint.reasoningSignalCount,
            hintMatchCount: endpoint.hintMatchCount,
        }))
        .sort((a, b) => {
            if (b.streamLikelyCount !== a.streamLikelyCount) {
                return b.streamLikelyCount - a.streamLikelyCount;
            }
            if (b.hintMatchCount !== a.hintMatchCount) {
                return b.hintMatchCount - a.hintMatchCount;
            }
            if (b.count !== a.count) {
                return b.count - a.count;
            }
            return `${a.host}${a.path}`.localeCompare(`${b.host}${b.path}`);
        });

    const likelyStreamingEndpoints = endpointSummary.filter((endpoint) => endpoint.streamLikelyCount > 0);

    return {
        generatedAt: new Date().toISOString(),
        sourceFile: options.sourceFile ?? null,
        hints: hints.map((hint) => hint.hint),
        hostFilter,
        stats: {
            totalEntries: entries.length,
            entriesScanned: timeline.length,
            entriesFilteredOut: filteredOut,
            timelineEvents: timeline.length,
            endpointCount: endpointSummary.length,
            streamLikelyEvents,
            reasoningSignalEvents,
            hintMatches: hintMatches.length,
        },
        likelyStreamingEndpoints,
        endpointSummary,
        hintMatches,
        timeline,
    };
};

const renderCount = (value: number): string => String(value).padStart(4, ' ');

export const renderHarAnalysisMarkdown = (analysis: HarAnalysisResult): string => {
    const lines: string[] = [];
    lines.push('# HAR Discovery Analysis');
    lines.push('');
    lines.push(`Generated: ${analysis.generatedAt}`);
    lines.push(`Source: ${analysis.sourceFile ?? 'N/A'}`);
    lines.push(`Host filter: ${analysis.hostFilter.length > 0 ? analysis.hostFilter.join(', ') : 'none'}`);
    lines.push(`Hints: ${analysis.hints.length > 0 ? analysis.hints.join(' | ') : 'none'}`);
    lines.push('');
    lines.push('## Summary');
    lines.push(`- Entries in HAR: ${analysis.stats.totalEntries}`);
    lines.push(`- Entries scanned: ${analysis.stats.entriesScanned}`);
    lines.push(`- Entries filtered out: ${analysis.stats.entriesFilteredOut}`);
    lines.push(`- Stream-likely events: ${analysis.stats.streamLikelyEvents}`);
    lines.push(`- Reasoning signal events: ${analysis.stats.reasoningSignalEvents}`);
    lines.push(`- Hint matches: ${analysis.stats.hintMatches}`);
    lines.push('');

    lines.push('## Likely Streaming Endpoints');
    if (analysis.likelyStreamingEndpoints.length === 0) {
        lines.push('- none');
    } else {
        for (const endpoint of analysis.likelyStreamingEndpoints) {
            lines.push(
                `- ${endpoint.method} ${endpoint.host}${endpoint.path} | hits=${endpoint.count} stream=${endpoint.streamLikelyCount} hints=${endpoint.hintMatchCount} reasoning=${endpoint.reasoningSignalCount}`,
            );
        }
    }
    lines.push('');

    lines.push('## Hint Matches');
    if (analysis.hintMatches.length === 0) {
        lines.push('- none');
    } else {
        for (const match of analysis.hintMatches) {
            lines.push(
                `- [${match.hint}] (${match.phase}) ${match.method} ${match.host}${match.path} @ ${match.startedDateTime ?? 'n/a'} :: ${match.snippet}`,
            );
        }
    }
    lines.push('');

    lines.push('## Timeline Highlights');
    for (const event of analysis.timeline) {
        const flags: string[] = [];
        if (event.streamLikely) {
            flags.push('stream');
        }
        if (event.reasoningSignals.length > 0) {
            flags.push(`reasoning=${event.reasoningSignals.join('+')}`);
        }
        if (event.hintMatches.length > 0) {
            flags.push(`hints=${event.hintMatches.join('|')}`);
        }
        const flagText = flags.length > 0 ? ` [${flags.join(', ')}]` : '';
        lines.push(
            `${event.startedDateTime ?? 'n/a'} | ${event.method} ${event.host}${event.path} | status=${event.status ?? 'n/a'} | mime=${event.mimeType ?? 'n/a'}${flagText}`,
        );
    }
    lines.push('');

    lines.push('## Endpoint Inventory');
    for (const endpoint of analysis.endpointSummary) {
        const statusText = endpoint.statuses.length > 0 ? endpoint.statuses.join(',') : 'n/a';
        const mimeText = endpoint.mimeTypes.length > 0 ? endpoint.mimeTypes.join(',') : 'n/a';
        const queryText = endpoint.queryKeys.length > 0 ? endpoint.queryKeys.join(',') : 'none';
        lines.push(
            `- ${renderCount(endpoint.count)}x ${endpoint.method} ${endpoint.host}${endpoint.path} | status=${statusText} | mime=${mimeText} | query=${queryText}`,
        );
    }

    return `${lines.join('\n')}\n`;
};
