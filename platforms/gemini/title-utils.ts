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

const collectTitleCandidates = (node: unknown, out: string[], depth = 0) => {
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

const hasAncestorTag = (node: Element, tagName: string): boolean => {
    let current: Element | null = node.parentElement;
    while (current) {
        if (current.tagName === tagName) {
            return true;
        }
        current = current.parentElement;
    }
    return false;
};

const getDocumentElements = (): Element[] => {
    if (typeof document === 'undefined' || typeof document.getElementsByTagName !== 'function') {
        return [];
    }
    try {
        return Array.from(document.getElementsByTagName('*'));
    } catch {
        return [];
    }
};

const firstValidTitleFromPredicateList = (predicates: Array<(node: Element) => boolean>): string | null => {
    const nodes = getDocumentElements();
    for (const predicate of predicates) {
        for (const node of nodes) {
            if (!predicate(node)) {
                continue;
            }
            const candidate = normalizeGeminiDomTitle((node.textContent ?? '').trim());
            if (!candidate || isGenericGeminiTitle(candidate)) {
                continue;
            }
            return candidate;
        }
    }
    return null;
};

const HEADING_PREDICATES: Array<(node: Element) => boolean> = [
    (node) => node.tagName === 'H1' && hasAncestorTag(node, 'MAIN'),
    (node) =>
        node.getAttribute('role') === 'heading' &&
        node.getAttribute('aria-level') === '1' &&
        hasAncestorTag(node, 'MAIN'),
    (node) => node.getAttribute('role') === 'heading' && hasAncestorTag(node, 'MAIN'),
    (node) => node.tagName === 'H1' && hasAncestorTag(node, 'HEADER'),
    (node) => node.tagName === 'H1',
];

const ACTIVE_NAV_PREDICATES: Array<(node: Element) => boolean> = [
    (node) => node.tagName === 'A' && node.getAttribute('aria-current') === 'page' && hasAncestorTag(node, 'NAV'),
    (node) => node.tagName === 'BUTTON' && node.getAttribute('aria-current') === 'page' && hasAncestorTag(node, 'NAV'),
    (node) => node.tagName === 'A' && node.getAttribute('aria-current') === 'page' && hasAncestorTag(node, 'ASIDE'),
    (node) =>
        node.tagName === 'BUTTON' && node.getAttribute('aria-current') === 'page' && hasAncestorTag(node, 'ASIDE'),
    (node) => node.getAttribute('role') === 'tab' && node.getAttribute('aria-selected') === 'true',
    (node) => node.getAttribute('aria-selected') === 'true' && hasAncestorTag(node, 'NAV'),
];

const extractConversationIdFromAppHref = (href: string): string | null =>
    href.match(/\/app\/([a-zA-Z0-9_-]+)/i)?.[1] ?? null;

const findTitleByConversationIdInHrefs = (conversationId: string): string | null => {
    const nodes = getDocumentElements();
    for (const node of nodes) {
        if (node.tagName !== 'A') {
            continue;
        }
        const href = node.getAttribute('href');
        if (!href || !href.includes('/app/')) {
            continue;
        }
        if (extractConversationIdFromAppHref(href) !== conversationId) {
            continue;
        }
        const candidate = normalizeGeminiDomTitle((node.textContent ?? '').trim());
        if (!candidate || isGenericGeminiTitle(candidate)) {
            continue;
        }
        return candidate;
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

    const headingTitle = firstValidTitleFromPredicateList(HEADING_PREDICATES);
    if (headingTitle) {
        return headingTitle;
    }

    const activeNavTitle = firstValidTitleFromPredicateList(ACTIVE_NAV_PREDICATES);
    if (activeNavTitle) {
        return activeNavTitle;
    }

    const activeConversationId = activeConversationIdFromLocation();
    if (activeConversationId) {
        return findTitleByConversationIdInHrefs(activeConversationId);
    }
    return null;
};
