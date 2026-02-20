import { logger } from '@/utils/logger';

const BUTTON_TARGET_MISS_LOG_INTERVAL_MS = 8_000;
let lastButtonTargetMissAt = 0;

const getNormalizedPath = (url: string) => {
    try {
        return new URL(url).pathname.toLowerCase();
    } catch {
        return url.toLowerCase();
    }
};

export const GROK_ENDPOINT_REGISTRY = {
    apiEndpointPattern:
        /\/i\/api\/graphql\/[^/]+\/(GrokConversationItemsByRestId|GrokHistory)|\/2\/grok\/add_response\.json|grok\.com\/rest\/app-chat\/conversations(_v2)?\/(?:new|reconnect-response-v2\/[^/?#]+|[^/]+(?:\/(response-node|load-responses))?)/i,
    completionTriggerPattern:
        /\/i\/api\/graphql\/[^/]+\/GrokConversationItemsByRestId|\/2\/grok\/add_response\.json|grok\.com\/rest\/app-chat\/conversations\/(new|[^/]+\/(response-node|load-responses))/i,
} as const;

export const GROK_PATH_REGISTRY = {
    generationMarkers: ['/rest/app-chat/conversations/new', '/2/grok/add_response.json'],
    reconnectMarker: '/rest/app-chat/conversations/reconnect-response-v2/',
    completionMarkers: ['/load-responses', '/response-node'],
    completionBaseMarker: '/rest/app-chat/conversations/',
    apiHintMarkers: ['/rest/app-chat/', '/2/grok/', '/i/api/graphql/'],
} as const;

export const GROK_SELECTOR_REGISTRY = {
    buttonInjectionTargets: ['[data-testid="grok-header"]', '[role="banner"]', 'header nav', 'header', 'body'],
    domTitleCandidates: [
        '[aria-current="page"][href*="/i/grok?conversation="] [dir="ltr"]',
        '[aria-current="page"][href*="/i/grok?conversation="] span',
        '[data-testid="grok-header"] h1',
        'main h1',
    ],
} as const;

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

export const isGrokGenerationEndpointUrl = (url: string): boolean =>
    isGrokGenerationEndpointPath(getNormalizedPath(url));

export const isGrokStreamingEndpointUrl = (url: string): boolean => {
    const path = getNormalizedPath(url);
    return isGrokGenerationEndpointPath(path) || path.includes(GROK_PATH_REGISTRY.reconnectMarker);
};

export const isGrokCompletionCandidateEndpointUrl = (url: string): boolean => {
    const path = getNormalizedPath(url);
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
    const path = getNormalizedPath(url);
    return GROK_PATH_REGISTRY.apiHintMarkers.some((marker) => path.includes(marker));
};
