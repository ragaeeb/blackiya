import { buildDomConversationSnapshot } from '@/entrypoints/interceptor/dom-snapshot';
import type { CaptureInterceptedMessage as CapturePayload } from '@/utils/protocol/messages';

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

const enqueueObjectChildren = (item: unknown, queue: unknown[]): void => {
    if (Array.isArray(item)) {
        queue.push(...item);
        return;
    }
    queue.push(...Object.values(item as Record<string, unknown>));
};

const shouldSkipScanItem = (item: unknown, seen: Set<unknown>): boolean => {
    return !item || typeof item !== 'object' || seen.has(item);
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Attempts to resolve a conversation snapshot in priority order:
 * 1. Known JS globals (__NEXT_DATA__, __remixContext, etc.)
 * 2. Live DOM traversal
 * 3. Raw intercepted capture history (last resort)
 *
 * `getRawCaptureHistory` is injected to avoid circular imports with the
 * capture-queue module.
 */
export const getPageConversationSnapshot = (
    conversationId: string,
    getRawCaptureHistory: () => CapturePayload[],
): unknown | null => {
    const globals: unknown[] = [
        (window as any).__NEXT_DATA__,
        (window as any).__remixContext,
        (window as any).__INITIAL_STATE__,
        (window as any).__APOLLO_STATE__,
        window,
    ];
    for (const root of globals) {
        const candidate = findConversationInGlobals(root, conversationId);
        if (candidate) {
            return candidate;
        }
    }

    const domSnapshot = buildDomConversationSnapshot(conversationId);
    if (domSnapshot) {
        return domSnapshot;
    }

    // Fall back to the raw capture ring-buffer
    const history = getRawCaptureHistory();
    for (let i = history.length - 1; i >= 0; i--) {
        const item = history[i];
        if (!item || typeof item.url !== 'string' || typeof item.data !== 'string') {
            continue;
        }
        if (!item.url.includes(conversationId) && !item.data.includes(conversationId)) {
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
    return null;
};
