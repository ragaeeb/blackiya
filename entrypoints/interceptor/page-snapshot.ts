import { buildDomConversationSnapshot } from '@/entrypoints/interceptor/dom-snapshot';
import type { CaptureInterceptedMessage as CapturePayload } from '@/utils/protocol/messages';

const CONVERSATION_ID_KEYS = new Set(['conversationId', 'conversation_id']);
const NATIVE_OBJECT_NAMES = new Set([
    'Date',
    'RegExp',
    'Error',
    'Promise',
    'Map',
    'Set',
    'WeakMap',
    'WeakSet',
    'ArrayBuffer',
    'DataView',
    'URL',
    'URLSearchParams',
]);

const isConversationLike = (candidate: unknown, conversationId: string): boolean => {
    if (!candidate || typeof candidate !== 'object') {
        return false;
    }
    const typed = candidate as Record<string, unknown>;
    if (typeof typed.title !== 'string' || !typed.mapping || typeof typed.mapping !== 'object') {
        return false;
    }
    return typed.conversation_id === conversationId || typed.id === conversationId;
};

const pickConversationCandidate = (item: unknown, conversationId: string): unknown | null => {
    if (isConversationLike(item, conversationId)) {
        return item;
    }
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
        return null;
    }
    const obj = item as Record<string, unknown>;
    if (isConversationLike(obj.conversation, conversationId)) {
        return obj.conversation;
    }
    if (isConversationLike(obj.data, conversationId)) {
        return obj.data;
    }
    return null;
};

const enqueueObjectChildren = (item: unknown, queue: unknown[]) => {
    if (Array.isArray(item)) {
        queue.push(...item);
        return;
    }
    try {
        queue.push(...Object.values(item as Record<string, unknown>));
    } catch {
        // Ignore objects with getter-backed properties that throw.
    }
};

const isDomNodeLike = (item: unknown): boolean => {
    if (!item || typeof item !== 'object') {
        return false;
    }
    const nodeType = (item as { nodeType?: unknown }).nodeType;
    const nodeName = (item as { nodeName?: unknown }).nodeName;
    return typeof nodeType === 'number' && typeof nodeName === 'string';
};

const isNativeObjectLike = (item: unknown): boolean => {
    if (!item || typeof item !== 'object') {
        return false;
    }
    const ctorName = (item as { constructor?: { name?: unknown } }).constructor?.name;
    return typeof ctorName === 'string' && NATIVE_OBJECT_NAMES.has(ctorName);
};

const shouldSkipScanItem = (item: unknown, seen: Set<unknown>): boolean => {
    if (!item || seen.has(item)) {
        return true;
    }
    if (typeof item === 'function') {
        return true;
    }
    if (typeof item !== 'object') {
        return true;
    }
    if (isDomNodeLike(item) || isNativeObjectLike(item)) {
        return true;
    }
    return false;
};

/**
 * BFS through an arbitrary JS object tree looking for a node that resembles a
 * conversation payload for the given ID. Bounded to 6 000 nodes to stay safe.
 */
const findConversationInGlobals = (root: unknown, conversationId: string): unknown | null => {
    const queue: unknown[] = [root];
    const seen = new Set<unknown>();
    let scanned = 0;

    while (queue.length > 0 && scanned < 6000) {
        const item = queue.shift();
        scanned += 1;
        if (shouldSkipScanItem(item, seen)) {
            continue;
        }
        seen.add(item);

        const candidate = pickConversationCandidate(item, conversationId);
        if (candidate) {
            return candidate;
        }

        enqueueObjectChildren(item, queue);
    }
    return null;
};

const hasConversationIdInMessages = (messages: unknown, conversationId: string): boolean => {
    if (!Array.isArray(messages)) {
        return false;
    }
    return messages.some((message) => {
        if (!message || typeof message !== 'object') {
            return false;
        }
        const msg = message as Record<string, unknown>;
        return (
            msg.conversationId === conversationId ||
            msg.conversation_id === conversationId ||
            (typeof msg.conversation === 'object' &&
                msg.conversation !== null &&
                ((msg.conversation as Record<string, unknown>).conversationId === conversationId ||
                    (msg.conversation as Record<string, unknown>).conversation_id === conversationId))
        );
    });
};

const hasConversationObjectIdMatch = (obj: Record<string, unknown>, conversationId: string) =>
    obj.id === conversationId &&
    (typeof obj.title === 'string' ||
        (typeof obj.mapping === 'object' && obj.mapping !== null) ||
        typeof obj.current_node === 'string');

const hasExplicitConversationIdKeyMatch = (obj: Record<string, unknown>, conversationId: string) => {
    for (const key of CONVERSATION_ID_KEYS) {
        if (obj[key] === conversationId) {
            return true;
        }
    }
    return false;
};

const hasConversationIdInArrayNode = (node: unknown[], conversationId: string, depth: number, visited: Set<unknown>) =>
    node.some((child) => hasConversationIdInParsedPayload(child, conversationId, depth + 1, visited));

const hasConversationIdInObjectNode = (
    obj: Record<string, unknown>,
    conversationId: string,
    depth: number,
    visited: Set<unknown>,
): boolean => {
    if (hasConversationObjectIdMatch(obj, conversationId) || hasExplicitConversationIdKeyMatch(obj, conversationId)) {
        return true;
    }
    if (hasConversationIdInMessages(obj.messages, conversationId)) {
        return true;
    }
    return Object.values(obj).some((value) =>
        hasConversationIdInParsedPayload(value, conversationId, depth + 1, visited),
    );
};

const hasConversationIdInParsedPayload = (
    node: unknown,
    conversationId: string,
    depth = 0,
    visited = new Set<unknown>(),
): boolean => {
    if (!node || typeof node !== 'object' || depth > 7 || visited.has(node)) {
        return false;
    }
    visited.add(node);
    if (Array.isArray(node)) {
        return hasConversationIdInArrayNode(node, conversationId, depth, visited);
    }
    return hasConversationIdInObjectNode(node as Record<string, unknown>, conversationId, depth, visited);
};

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const hasConversationIdInRawString = (raw: string, conversationId: string): boolean => {
    const escapedConversationId = escapeRegExp(conversationId);
    const conversationKeyRegex = new RegExp(
        `"(?:conversationId|conversation_id)"\\s*:\\s*"${escapedConversationId}"`,
        'i',
    );
    const conversationObjectIdRegex = new RegExp(`"id"\\s*:\\s*"${escapedConversationId}"`, 'i');
    return conversationKeyRegex.test(raw) || conversationObjectIdRegex.test(raw);
};

const rawCaptureMatchesConversation = (item: CapturePayload, conversationId: string): boolean => {
    if (item.url.includes(conversationId)) {
        return true;
    }
    try {
        const parsed = JSON.parse(item.data) as unknown;
        return hasConversationIdInParsedPayload(parsed, conversationId);
    } catch {
        return hasConversationIdInRawString(item.data, conversationId);
    }
};

// Public API

/**
 * Attempts to resolve a conversation snapshot in priority order:
 * 1. Raw intercepted capture history (highest fidelity)
 * 2. Known JS globals (__NEXT_DATA__, __remixContext, etc.)
 * 3. Live DOM traversal
 * 4. Broad `window` BFS fallback
 *
 * `getRawCaptureHistory` is injected to avoid circular imports with the
 * capture-queue module.
 */
export const getPageConversationSnapshot = (
    conversationId: string,
    getRawCaptureHistory: () => CapturePayload[],
): unknown | null => {
    // Prefer raw capture replay first so downstream parsing can recover
    // canonical fields (model/reasoning/etc.) even when DOM/global snapshots
    // are partial and backend fetch endpoints are unavailable.
    const history = getRawCaptureHistory();
    for (let i = history.length - 1; i >= 0; i--) {
        const item = history[i];
        if (!item || typeof item.url !== 'string' || typeof item.data !== 'string') {
            continue;
        }
        if (!rawCaptureMatchesConversation(item, conversationId)) {
            continue;
        }
        return {
            __blackiyaSnapshotType: 'raw-capture' as const,
            url: item.url,
            data: item.data,
            platform: item.platform,
            conversationId,
        };
    }

    const knownGlobals: unknown[] = [
        (window as any).__NEXT_DATA__,
        (window as any).__remixContext,
        (window as any).__INITIAL_STATE__,
        (window as any).__APOLLO_STATE__,
    ];
    for (const root of knownGlobals) {
        const candidate = findConversationInGlobals(root, conversationId);
        if (candidate) {
            return candidate;
        }
    }

    const domSnapshot = buildDomConversationSnapshot(conversationId);
    if (domSnapshot) {
        return domSnapshot;
    }

    const windowFallback = findConversationInGlobals(window, conversationId);
    if (windowFallback) {
        return windowFallback;
    }
    return null;
};
