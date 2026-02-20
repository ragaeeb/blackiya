import { GEMINI_RPC_IDS } from '@/platforms/constants';
import { logger } from '@/utils/logger';

const BUTTON_TARGET_MISS_LOG_INTERVAL_MS = 8_000;
let lastButtonTargetMissAt = 0;

const parseGeminiUrl = (url: string) => {
    try {
        return new URL(url, 'https://gemini.google.com');
    } catch {
        return null;
    }
};

const getNormalizedPath = (url: string) => {
    const parsed = parseGeminiUrl(url);
    if (parsed) {
        return parsed.pathname.toLowerCase();
    }
    return url.toLowerCase();
};

export const GEMINI_ENDPOINT_REGISTRY = {
    apiEndpointPattern:
        /\/_\/BardChatUi\/data\/(?:batchexecute(?:\?.*)?|assistant\.lamda\.BardFrontendService\/StreamGenerate)/i,
    completionTriggerPattern:
        /\/_\/BardChatUi\/data\/(?:batchexecute(?:\?.*)?|assistant\.lamda\.BardFrontendService\/StreamGenerate)/i,
    generationEndpointPattern: /\/_\/BardChatUi\/data\/assistant\.lamda\.BardFrontendService\/StreamGenerate/i,
} as const;

export const GEMINI_SELECTOR_REGISTRY = {
    buttonInjectionTargets: [
        'header [aria-haspopup="menu"]',
        'header .flex-1.overflow-hidden',
        'header nav',
        '.chat-app-header',
        'header',
        '[role="banner"]',
        'body',
    ],
} as const;

const maybeLogButtonTargetMiss = () => {
    const now = Date.now();
    if (now - lastButtonTargetMissAt < BUTTON_TARGET_MISS_LOG_INTERVAL_MS) {
        return;
    }
    lastButtonTargetMissAt = now;
    logger.warn('[Blackiya/Gemini] Button target selectors unmatched', {
        selectors: [...GEMINI_SELECTOR_REGISTRY.buttonInjectionTargets],
    });
};

export const resolveGeminiButtonInjectionTarget = (
    doc: Pick<Document, 'querySelector'> | null = typeof document === 'undefined' ? null : document,
): HTMLElement | null => {
    if (!doc) {
        return null;
    }
    for (const selector of GEMINI_SELECTOR_REGISTRY.buttonInjectionTargets) {
        const target = doc.querySelector(selector);
        if (target) {
            return (target.parentElement || target) as HTMLElement;
        }
    }
    maybeLogButtonTargetMiss();
    return null;
};

export const isGeminiGenerationEndpointUrl = (url: string): boolean =>
    GEMINI_ENDPOINT_REGISTRY.generationEndpointPattern.test(url);

export const isGeminiTitlesEndpointUrl = (url: string): boolean => {
    const parsed = parseGeminiUrl(url);
    if (parsed) {
        if (!parsed.pathname.toLowerCase().includes('/_/bardchatui/data/batchexecute')) {
            return false;
        }
        const rpcids = parsed.searchParams.get('rpcids');
        return typeof rpcids === 'string' && rpcids.toLowerCase() === GEMINI_RPC_IDS.TITLES.toLowerCase();
    }
    return (
        /\/_\/BardChatUi\/data\/batchexecute/i.test(url) &&
        new RegExp(`(?:^|[?&])rpcids=${GEMINI_RPC_IDS.TITLES}(?:&|$)`, 'i').test(url)
    );
};

export const isLikelyGeminiApiPath = (url: string): boolean => getNormalizedPath(url).includes('/_/bardchatui/data/');
