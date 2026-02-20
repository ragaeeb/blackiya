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

export const CHATGPT_ENDPOINT_REGISTRY = {
    promptRequestPathPattern: /\/backend-api\/(?:f\/)?conversation(?:\?.*)?$/i,
    apiEndpointPattern:
        /(?:backend-api\/conversation\/[a-f0-9-]+(?:\/)?(?:\?.*)?$|backend-api\/f\/conversation(?:\/[a-f0-9-]+)?(?:\/)?(?:\?.*)?$)/i,
    completionTriggerPattern: /backend-api\/(?:f\/)?conversation\/[a-f0-9-]+\/stream_status(?:\?.*)?$/i,
} as const;

export const CHATGPT_SELECTOR_REGISTRY = {
    buttonInjectionTargets: [
        '[data-testid="model-switcher-dropdown-button"]',
        'header nav',
        '.flex.items-center.justify-between',
        'header .flex',
    ],
    generationIndicators: [
        'button[data-testid="stop-button"]',
        'button[aria-label*="Stop generating"]',
        'button[aria-label*="Stop response"]',
        '[data-is-streaming="true"]',
    ],
} as const;

const maybeLogButtonTargetMiss = () => {
    const now = Date.now();
    if (now - lastButtonTargetMissAt < BUTTON_TARGET_MISS_LOG_INTERVAL_MS) {
        return;
    }
    lastButtonTargetMissAt = now;
    logger.warn('[Blackiya/ChatGPT] Button target selectors unmatched', {
        selectors: [...CHATGPT_SELECTOR_REGISTRY.buttonInjectionTargets],
    });
};

export const resolveChatGptButtonInjectionTarget = (
    doc: Pick<Document, 'querySelector'> | null = typeof document === 'undefined' ? null : document,
): HTMLElement | null => {
    if (!doc) {
        return null;
    }
    for (const selector of CHATGPT_SELECTOR_REGISTRY.buttonInjectionTargets) {
        const target = doc.querySelector(selector);
        if (target) {
            return (target.parentElement || target) as HTMLElement;
        }
    }
    maybeLogButtonTargetMiss();
    return null;
};

export const isChatGptGeneratingFromDom = (
    doc: Pick<Document, 'querySelector'> | null = typeof document === 'undefined' ? null : document,
) => {
    if (!doc) {
        return false;
    }
    return CHATGPT_SELECTOR_REGISTRY.generationIndicators.some((selector) => !!doc.querySelector(selector));
};

export const isLikelyChatGptApiPath = (url: string) => getNormalizedPath(url).includes('/backend-api/');
