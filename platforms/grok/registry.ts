import { logger } from '@/utils/logger';

const BUTTON_TARGET_MISS_LOG_INTERVAL_MS = 8_000;
let lastButtonTargetMissAt = 0;

export const GROK_ENDPOINT_REGISTRY = {
    apiEndpointPattern:
        /grok\.x\.com\/2\/grok\/add_response\.json|grok\.com\/rest\/app-chat\/conversations(_v2)?\/(?:new|reconnect-response-v2\/[^/?#]+|[^/]+(?:\/(response-node|load-responses))?)/i,
    completionTriggerPattern:
        /grok\.x\.com\/2\/grok\/add_response\.json|grok\.com\/rest\/app-chat\/conversations\/(new|[^/]+\/(response-node|load-responses))/i,
} as const;

export const GROK_PATH_REGISTRY = {
    generationMarkers: ['/rest/app-chat/conversations/new'],
    streamingGenerationMarker: '/2/grok/add_response.json',
    reconnectMarker: '/rest/app-chat/conversations/reconnect-response-v2/',
    completionMarkers: ['/load-responses', '/response-node'],
    completionBaseMarker: '/rest/app-chat/conversations/',
    apiHintMarkers: ['/rest/app-chat/'],
    streamingApiHintMarker: '/2/grok/',
} as const;

export const GROK_SELECTOR_REGISTRY = {
    buttonInjectionTargets: ['[data-testid="grok-header"]', '[role="banner"]', 'header nav', 'header', 'body'],
    domTitleCandidates: ['[data-testid="grok-header"] h1', 'main h1'],
} as const;

export const GROK_DEFAULT_TITLES = ['New conversation', 'Grok Conversation'] as const;

const maybeLogButtonTargetMiss = () => {
    const now = Date.now();
    if (now - lastButtonTargetMissAt < BUTTON_TARGET_MISS_LOG_INTERVAL_MS) {
        return;
    }
    lastButtonTargetMissAt = now;
    logger.warn('[Blackiya/Grok] Button target selectors unmatched', {
        selectors: [...GROK_SELECTOR_REGISTRY.buttonInjectionTargets],
    });
};

export const resolveGrokButtonInjectionTarget = (
    doc: Pick<Document, 'querySelector'> | null = typeof document === 'undefined' ? null : document,
): HTMLElement | null => {
    if (!doc) {
        return null;
    }
    for (const selector of GROK_SELECTOR_REGISTRY.buttonInjectionTargets) {
        const target = doc.querySelector(selector);
        if (target) {
            return (target.parentElement || target) as HTMLElement;
        }
    }
    maybeLogButtonTargetMiss();
    return null;
};

export const isGrokGenerationEndpointPath = (path: string): boolean =>
    GROK_PATH_REGISTRY.generationMarkers.some((marker) => path.includes(marker));

const parseUrlHostAndPath = (url: string): { hostname: string; path: string } => {
    try {
        const parsed = new URL(url);
        return { hostname: parsed.hostname.toLowerCase(), path: parsed.pathname.toLowerCase() };
    } catch {
        return { hostname: '', path: url.toLowerCase() };
    }
};

const isGrokHost = (hostname: string) => hostname === 'grok.com' || hostname.endsWith('.grok.com');

const isGrokStreamingHost = (hostname: string) => hostname === 'grok.x.com' || hostname.endsWith('.grok.x.com');

export const isGrokGenerationEndpointUrl = (url: string): boolean =>
    (() => {
        const { hostname, path } = parseUrlHostAndPath(url);
        return (
            (isGrokHost(hostname) && isGrokGenerationEndpointPath(path)) ||
            (isGrokStreamingHost(hostname) && path.includes(GROK_PATH_REGISTRY.streamingGenerationMarker))
        );
    })();

export const isGrokStreamingEndpointUrl = (url: string): boolean => {
    const { hostname, path } = parseUrlHostAndPath(url);
    return (
        (isGrokHost(hostname) &&
            (isGrokGenerationEndpointPath(path) || path.includes(GROK_PATH_REGISTRY.reconnectMarker))) ||
        (isGrokStreamingHost(hostname) && path.includes(GROK_PATH_REGISTRY.streamingGenerationMarker))
    );
};

export const isGrokCompletionCandidateEndpointUrl = (url: string): boolean => {
    const { hostname, path } = parseUrlHostAndPath(url);
    if (!isGrokHost(hostname)) {
        return false;
    }
    if (path.includes(GROK_PATH_REGISTRY.generationMarkers[0])) {
        return false;
    }
    if (path.includes(GROK_PATH_REGISTRY.reconnectMarker)) {
        return false;
    }
    return (
        path.includes(GROK_PATH_REGISTRY.completionBaseMarker) &&
        GROK_PATH_REGISTRY.completionMarkers.some((marker) => path.includes(marker))
    );
};

export const isLikelyGrokApiPath = (url: string): boolean => {
    const { hostname, path } = parseUrlHostAndPath(url);
    if (isGrokHost(hostname)) {
        return GROK_PATH_REGISTRY.apiHintMarkers.some((marker) => path.includes(marker));
    }
    if (isGrokStreamingHost(hostname)) {
        return path.includes(GROK_PATH_REGISTRY.streamingApiHintMarker);
    }
    return false;
};
