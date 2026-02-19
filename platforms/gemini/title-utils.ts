import { isGenericConversationTitle } from '@/utils/title-resolver';

export const GEMINI_DEFAULT_TITLES = ['Gemini Conversation', 'Google Gemini', 'Conversation with Gemini'];

export const normalizeGeminiDomTitle = (rawTitle: string) =>
    rawTitle
        .replace(/\s*[-|]\s*Gemini(?:\s+Advanced)?$/i, '')
        .replace(/\s*[-|]\s*Google Gemini$/i, '')
        .replace(/\s+/g, ' ')
        .trim();

export const isGenericGeminiTitle = (rawTitle: string) =>
    isGenericConversationTitle(normalizeGeminiDomTitle(rawTitle), {
        platformDefaultTitles: GEMINI_DEFAULT_TITLES,
    });

export const normalizeGeminiTitleCandidate = (rawTitle: unknown): string | null => {
    if (typeof rawTitle !== 'string') {
        return null;
    }
    const normalized = normalizeGeminiDomTitle(rawTitle).replace(/\s+/g, ' ').trim();
    if (normalized.length < 3 || normalized.length > 180) {
        return null;
    }
    if (normalized.includes('\n')) {
        return null;
    }
    if (isGenericGeminiTitle(normalized)) {
        return null;
    }
    return normalized;
};

// ── Payload title candidate collection ────────────────────────────────────────

const collectTitleCandidates = (node: unknown, out: string[], depth = 0): void => {
    if (depth > 8 || out.length >= 16 || !node || typeof node !== 'object') {
        return;
    }

    if (Array.isArray(node)) {
        for (const child of node) {
            collectTitleCandidates(child, out, depth + 1);
        }
        return;
    }

    const obj = node as Record<string, unknown>;

    for (const slot of [obj['11'], obj.title]) {
        const candidates = Array.isArray(slot) ? slot : [slot];
        for (const c of candidates) {
            const norm = normalizeGeminiTitleCandidate(c);
            if (norm && !out.includes(norm)) {
                out.push(norm);
            }
        }
    }

    for (const value of Object.values(obj)) {
        collectTitleCandidates(value, out, depth + 1);
    }
};

export const extractTitleCandidatesFromPayload = (payload: unknown): string[] => {
    const candidates: string[] = [];
    collectTitleCandidates(payload, candidates);
    return candidates;
};

// ── DOM title extraction ───────────────────────────────────────────────────────

const HEADING_SELECTORS = [
    'main h1',
    'main [role="heading"][aria-level="1"]',
    'main [role="heading"]',
    'header h1',
    'h1',
];

const ACTIVE_NAV_SELECTORS = [
    'nav a[aria-current="page"]',
    'nav button[aria-current="page"]',
    'aside a[aria-current="page"]',
    'aside button[aria-current="page"]',
    '[role="tab"][aria-selected="true"]',
    'nav [aria-selected="true"]',
];

const APP_HREF_SELECTORS = [
    'nav a[href*="/app/"]',
    'aside a[href*="/app/"]',
    '[role="navigation"] a[href*="/app/"]',
    'a[href*="/app/"]',
];

const firstValidTitleFromSelectors = (selectors: string[]): string | null => {
    for (const selector of selectors) {
        for (const node of document.querySelectorAll(selector)) {
            const candidate = normalizeGeminiDomTitle((node.textContent ?? '').trim());
            if (candidate && !isGenericGeminiTitle(candidate)) {
                return candidate;
            }
        }
    }
    return null;
};

const extractConversationIdFromAppHref = (href: string): string | null =>
    href.match(/\/app\/([a-zA-Z0-9_-]+)/i)?.[1] ?? null;

const findTitleByConversationIdInHrefs = (conversationId: string): string | null => {
    for (const selector of APP_HREF_SELECTORS) {
        for (const node of document.querySelectorAll(selector)) {
            const href = node.getAttribute('href');
            if (!href) {
                continue;
            }
            if (extractConversationIdFromAppHref(href) !== conversationId) {
                continue;
            }
            const candidate = normalizeGeminiDomTitle((node.textContent ?? '').trim());
            if (candidate && !isGenericGeminiTitle(candidate)) {
                return candidate;
            }
        }
    }
    return null;
};

const activeConversationIdFromLocation = (): string | null => {
    if (typeof window === 'undefined') {
        return null;
    }
    const href = window.location?.href;
    if (typeof href !== 'string' || href.length === 0) {
        return null;
    }
    return href.match(/\/app\/([a-zA-Z0-9_-]+)/i)?.[1] ?? null;
};

export const extractTitleFromGeminiDom = (): string | null => {
    if (typeof document === 'undefined') {
        return null;
    }

    const tabTitle = normalizeGeminiDomTitle(document.title?.trim() ?? '');
    if (tabTitle && !isGenericGeminiTitle(tabTitle)) {
        return tabTitle;
    }

    const headingTitle = firstValidTitleFromSelectors(HEADING_SELECTORS);
    if (headingTitle) {
        return headingTitle;
    }

    const activeNavTitle = firstValidTitleFromSelectors(ACTIVE_NAV_SELECTORS);
    if (activeNavTitle) {
        return activeNavTitle;
    }

    const activeConversationId = activeConversationIdFromLocation();
    if (activeConversationId) {
        return findTitleByConversationIdInHrefs(activeConversationId);
    }
    return null;
};
