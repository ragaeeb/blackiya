/**
 * DOM snapshot building utilities.
 *
 * Two levels of helpers live here:
 *  1. Pure builders (`buildConversationSnapshotFromMessages`, `buildRunnerSnapshotConversationData`)
 *     that construct ConversationData from pre-collected message arrays.
 *  2. DOM collection utilities (`collectSnapshotMessageCandidates`, `buildIsolatedDomSnapshot`, …)
 *     that read from a live ParentNode and should be called only in a browser context.
 */

import type { LLMPlatform } from '@/platforms/types';
import { logger } from '@/utils/logger';
import type { ConversationData } from '@/utils/types';

// Shared types

export type SnapshotMessageCandidate = {
    role: 'user' | 'assistant';
    text: string;
};

// Pure builders

/**
 * Build a lightweight root-anchored chain snapshot used by targeted probe helpers.
 * This shape intentionally keeps a synthetic `root` node and zero-based `snapshot-0` IDs.
 * The runner calibration fallback uses `buildRunnerSnapshotConversationData` below.
 */
export const buildConversationSnapshotFromMessages = (
    conversationId: string,
    title: string,
    messages: SnapshotMessageCandidate[],
): ConversationData | null => {
    if (!conversationId || messages.length === 0) {
        return null;
    }

    const now = Date.now() / 1000;
    const mapping: ConversationData['mapping'] = {
        root: { id: 'root', message: null, parent: null, children: [] },
    };

    let parentId = 'root';
    messages.forEach((message, index) => {
        const id = `snapshot-${index}`;
        mapping[parentId]?.children.push(id);
        mapping[id] = {
            id,
            parent: parentId,
            children: [],
            message: {
                id,
                author: { role: message.role, name: null, metadata: {} },
                content: { content_type: 'text', parts: [message.text] },
                create_time: now,
                update_time: now,
                status: 'finished_successfully',
                end_turn: true,
                weight: 1,
                metadata: {},
                recipient: 'all',
                channel: null,
            },
        };
        parentId = id;
    });

    return {
        title: title || 'Conversation',
        create_time: now,
        update_time: now,
        conversation_id: conversationId,
        current_node: parentId,
        moderation_results: [],
        plugin_ids: null,
        gizmo_id: null,
        gizmo_type: null,
        is_archived: false,
        default_model_slug: 'unknown',
        safe_urls: [],
        blocked_urls: [],
        mapping,
    };
};

export const buildRunnerSnapshotConversationData = (
    conversationId: string,
    platformName: string,
    messages: SnapshotMessageCandidate[],
    documentTitle?: string,
): ConversationData | null => {
    if (!conversationId || messages.length === 0) {
        return null;
    }

    const mapping: ConversationData['mapping'] = {};
    const now = Date.now() / 1000;

    for (let index = 0; index < messages.length; index++) {
        const msg = messages[index];
        const id = `snapshot-${index + 1}`;
        mapping[id] = {
            id,
            message: {
                id,
                author: {
                    role: msg.role,
                    name: msg.role === 'user' ? 'User' : platformName,
                    metadata: {},
                },
                create_time: now + index,
                update_time: now + index,
                content: {
                    content_type: 'text',
                    parts: [msg.text],
                },
                status: 'finished_successfully',
                end_turn: true,
                weight: 1,
                metadata: {},
                recipient: 'all',
                channel: null,
            },
            parent: index === 0 ? null : `snapshot-${index}`,
            children: index === messages.length - 1 ? [] : [`snapshot-${index + 2}`],
        };
    }

    return {
        title: documentTitle || `${platformName} Conversation`,
        create_time: now,
        update_time: now + messages.length,
        conversation_id: conversationId,
        mapping,
        current_node: `snapshot-${messages.length}`,
        moderation_results: [],
        plugin_ids: null,
        gizmo_id: null,
        gizmo_type: null,
        is_archived: false,
        default_model_slug: 'snapshot',
        safe_urls: [],
        blocked_urls: [],
    };
};

// DOM collection utilities

export const normalizeSnapshotText = (text: string): string => text.replace(/\s+/g, ' ').trim();

export const queryAllFromRoot = (root: ParentNode, selector: string): Element[] => {
    if (!root || typeof (root as { querySelectorAll?: unknown }).querySelectorAll !== 'function') {
        return [];
    }
    try {
        return Array.from(root.querySelectorAll(selector));
    } catch {
        return [];
    }
};

const SNAPSHOT_ROLE_SELECTORS: Array<{ selector: string; role: 'user' | 'assistant' }> = [
    { selector: '[data-message-author-role="user"]', role: 'user' },
    { selector: '[data-message-author-role="assistant"]', role: 'assistant' },
    { selector: '[class*="user-query"]', role: 'user' },
    { selector: '[class*="model-response"]', role: 'assistant' },
    { selector: 'user-query', role: 'user' },
    { selector: 'model-response', role: 'assistant' },
];

/**
 * Collects role-labelled message candidates from a DOM subtree using
 * known platform selectors. Deduplicates by (role, text) pair.
 */
export const collectSnapshotMessageCandidates = (root: ParentNode): SnapshotMessageCandidate[] => {
    const collected: SnapshotMessageCandidate[] = [];

    for (const entry of SNAPSHOT_ROLE_SELECTORS) {
        for (const node of queryAllFromRoot(root, entry.selector)) {
            const text = normalizeSnapshotText((node.textContent ?? '').trim());
            if (text.length >= 2) {
                collected.push({ role: entry.role, text });
            }
        }
    }

    const seen = new Set<string>();
    const deduped: SnapshotMessageCandidate[] = [];
    for (const item of collected) {
        const key = `${item.role}:${item.text}`;
        if (!seen.has(key)) {
            seen.add(key);
            deduped.push(item);
        }
    }
    return deduped;
};

/**
 * Grok-specific fallback: collects article/message nodes from `main` and
 * alternates role assignment when platform markup carries no role labels.
 */
export const collectLooseGrokCandidates = (root: ParentNode): SnapshotMessageCandidate[] => {
    const nodes = queryAllFromRoot(
        root,
        'main article, main [data-testid*="message"], main [class*="message"], main [class*="response"]',
    );

    const uniqueTexts = Array.from(
        new Set(
            nodes
                .map((node) => normalizeSnapshotText((node.textContent ?? '').trim()))
                .filter((text) => text.length >= 8),
        ),
    );

    if (uniqueTexts.length < 2) {
        return [];
    }
    return uniqueTexts.map((text, index) => ({
        role: index % 2 === 0 ? 'user' : 'assistant',
        text,
    }));
};

const resolveTreeWalkerContext = (root: ParentNode): { ownerDocument: Document; walkerRoot: Node } | null => {
    const ownerDocument = root instanceof Document ? root : root.ownerDocument;
    const walkerRoot = root instanceof Element || root instanceof Document ? root : ownerDocument?.body;
    if (!ownerDocument || !walkerRoot) {
        return null;
    }
    return { ownerDocument, walkerRoot };
};

const createSnapshotContainerFilter = (allowedTags: Set<string>): NodeFilter => ({
    acceptNode: (candidate: Node) =>
        candidate instanceof Element && allowedTags.has(candidate.tagName)
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_SKIP,
});

const collectTreeWalkerSnippets = (walker: TreeWalker, snippets: string[], maxNodesScanned: number) => {
    let scanned = 0;
    let node = walker.nextNode();
    while (node && snippets.length < 6 && scanned < maxNodesScanned) {
        scanned += 1;
        const text = normalizeSnapshotText((node.textContent ?? '').trim());
        if (text.length >= 40 && text.length <= 1200) {
            snippets.push(text);
        }
        node = walker.nextNode();
    }
};

const collectLastResortSnippets = (root: ParentNode): string[] => {
    const snippets: string[] = [];
    const context = resolveTreeWalkerContext(root);
    if (context) {
        const walker = context.ownerDocument.createTreeWalker(
            context.walkerRoot,
            NodeFilter.SHOW_ELEMENT,
            createSnapshotContainerFilter(new Set(['MAIN', 'ARTICLE', 'SECTION', 'DIV'])),
        );
        collectTreeWalkerSnippets(walker, snippets, 220);
    }
    if (snippets.length === 0) {
        for (const node of queryAllFromRoot(root, 'main, article, section, div')) {
            const text = normalizeSnapshotText((node.textContent ?? '').trim());
            if (text.length >= 40 && text.length <= 1200) {
                snippets.push(text);
                if (snippets.length >= 6) {
                    break;
                }
            }
        }
    }
    return Array.from(new Set(snippets));
};

/**
 * Last-resort candidate collection via tree-walker or broad selector fallback.
 * Role assignment is synthetic (alternating), used only when no labelled nodes exist.
 */
export const collectLastResortTextCandidates = (root: ParentNode): SnapshotMessageCandidate[] => {
    const unique = collectLastResortSnippets(root);
    if (unique.length === 0) {
        return [];
    }
    if (unique.length === 1) {
        return [];
    }
    return unique.slice(0, 6).map((text, index) => ({
        role: index % 2 === 0 ? 'user' : 'assistant',
        text,
    }));
};

// Snapshot builders that use DOM collection

const buildPrimarySnapshotFromRoot = (
    adapter: LLMPlatform,
    conversationId: string,
    root: ParentNode,
): ConversationData | null => {
    const candidates = collectSnapshotMessageCandidates(root);
    if (candidates.length < 2) {
        return null;
    }
    logger.info('Calibration isolated DOM snapshot candidates found', {
        conversationId,
        platform: adapter.name,
        count: candidates.length,
    });
    return buildRunnerSnapshotConversationData(conversationId, adapter.name, candidates, document.title);
};

const buildGrokFallbackSnapshotFromRoot = (
    adapter: LLMPlatform,
    conversationId: string,
    root: ParentNode,
): ConversationData | null => {
    const looseCandidates = collectLooseGrokCandidates(root);
    if (looseCandidates.length >= 2) {
        logger.info('Calibration isolated DOM Grok fallback candidates found', {
            conversationId,
            platform: adapter.name,
            count: looseCandidates.length,
        });
        return buildRunnerSnapshotConversationData(conversationId, adapter.name, looseCandidates, document.title);
    }

    const lastResort = collectLastResortTextCandidates(root);
    if (lastResort.length < 2) {
        return null;
    }
    logger.info('Calibration isolated DOM Grok last-resort candidates found', {
        conversationId,
        platform: adapter.name,
        count: lastResort.length,
    });
    return buildRunnerSnapshotConversationData(conversationId, adapter.name, lastResort, document.title);
};

const buildSnapshotFromRoot = (
    adapter: LLMPlatform,
    conversationId: string,
    root: ParentNode,
): ConversationData | null => {
    const primary = buildPrimarySnapshotFromRoot(adapter, conversationId, root);
    if (primary) {
        return primary;
    }
    if (adapter.name !== 'Grok') {
        return null;
    }
    return buildGrokFallbackSnapshotFromRoot(adapter, conversationId, root);
};

/**
 * Attempts to build a ConversationData snapshot from the live DOM by probing
 * `<main>` first, then `document.body`. Returns `null` if no usable candidates
 * are found in either root.
 */
export const buildIsolatedDomSnapshot = (adapter: LLMPlatform, conversationId: string): ConversationData | null => {
    const roots: ParentNode[] = [];
    try {
        const main = typeof document.querySelector === 'function' ? document.querySelector('main') : null;
        if (main) {
            roots.push(main);
        }
    } catch {
        // ignore
    }
    if (document.body) {
        roots.push(document.body);
    }

    for (const root of roots) {
        const snapshot = buildSnapshotFromRoot(adapter, conversationId, root);
        if (snapshot) {
            return snapshot;
        }
    }
    return null;
};
