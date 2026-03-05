const findElementByAttribute = (root: Element, attributeName: string): Element | null => {
    try {
        const direct = root.querySelector(`[${attributeName}]`);
        if (direct) {
            return direct;
        }
    } catch {
        // Fall through to a manual scan when selector engines reject the selector.
    }
    for (const element of Array.from(root.getElementsByTagName('*'))) {
        if (element.hasAttribute(attributeName)) {
            return element;
        }
    }
    return null;
};

const extractTurnRole = (turn: Element): 'system' | 'user' | 'assistant' | 'tool' | null => {
    const role = findElementByAttribute(turn, 'data-message-author-role')?.getAttribute('data-message-author-role');
    if (role === 'system' || role === 'user' || role === 'assistant' || role === 'tool') {
        return role;
    }
    return null;
};

const extractTurnModelSlug = (turn: Element): string | null => {
    const modelEl = findElementByAttribute(turn, 'data-message-model-slug');
    const slug = modelEl?.getAttribute('data-message-model-slug');
    return typeof slug === 'string' && slug.trim().length > 0 ? slug.trim() : null;
};

const extractTurnText = (turn: Element): string => {
    const el =
        turn.querySelector(
            '.whitespace-pre-wrap, .markdown, [data-message-content], [data-testid="conversation-turn-content"]',
        ) ?? turn.querySelector('[data-message-author-role]');
    return (el?.textContent ?? '').trim();
};

const extractThoughtFragments = (turn: Element): string[] => {
    const selectors = [
        '[data-testid*="thought"]',
        '[data-message-content-type="thought"]',
        '[data-content-type="thought"]',
        'details summary',
    ];
    const fragments: string[] = [];
    for (const selector of selectors) {
        for (const node of turn.querySelectorAll(selector)) {
            const text = (node.textContent ?? '').trim();
            if (text.length > 0) {
                fragments.push(text);
            }
        }
    }
    return [...new Set(fragments)];
};

const normalizeDomTitle = (rawTitle: string) => rawTitle.replace(/\s*[-|]\s*ChatGPT.*$/i, '').trim();

const buildThoughtEntries = (thoughtFragments: string[]) =>
    thoughtFragments.map((summary) => ({
        summary,
        content: summary,
        chunks: [],
        finished: true,
    }));

const buildDomMessageContent = (text: string, thoughtFragments: string[]): Record<string, unknown> => {
    if (thoughtFragments.length === 0) {
        return { content_type: 'text', parts: text ? [text] : [] };
    }
    const thoughts = buildThoughtEntries(thoughtFragments);
    if (text.length === 0) {
        return {
            content_type: 'thoughts',
            thoughts,
        };
    }
    return {
        content_type: 'text',
        parts: [text],
        thoughts,
    };
};

type DomTurnResult = {
    messageId: string;
    node: Record<string, unknown>;
    modelSlug: string | null;
};

const buildDomTurnNode = (
    turn: Element,
    conversationId: string,
    index: number,
    parentId: string,
    now: number,
): DomTurnResult | null => {
    const role = extractTurnRole(turn);
    if (!role) {
        return null;
    }
    const text = extractTurnText(turn);
    const thoughtFragments = extractThoughtFragments(turn);
    if (!text && thoughtFragments.length === 0) {
        return null;
    }
    const modelSlug = role === 'assistant' ? extractTurnModelSlug(turn) : null;
    const messageId = `dom-${conversationId}-${index}`;
    const content = buildDomMessageContent(text, thoughtFragments);
    const metadata: Record<string, unknown> =
        thoughtFragments.length > 0 ? { reasoning: thoughtFragments.join('\n\n') } : {};
    if (modelSlug) {
        metadata.model_slug = modelSlug;
    }
    return {
        messageId,
        modelSlug,
        node: {
            id: messageId,
            message: {
                id: messageId,
                author: { role, name: null, metadata: {} },
                create_time: now + index,
                update_time: now + index,
                content,
                status: 'finished_successfully',
                end_turn: true,
                weight: 1,
                metadata,
                recipient: 'all',
                channel: null,
            },
            parent: parentId,
            children: [],
        },
    };
};

// Public API

const findConversationTurns = (): Element[] => {
    try {
        const turns = Array.from(document.querySelectorAll('[data-testid^="conversation-turn-"]'));
        if (turns.length > 0) {
            return turns;
        }
    } catch {
        // Fall through to manual scan for selector-engine incompatibilities.
    }

    const allElements = Array.from(document.getElementsByTagName('*'));
    return allElements.filter((element) => {
        const testId = element.getAttribute('data-testid');
        return typeof testId === 'string' && testId.startsWith('conversation-turn-');
    });
};

/**
 * Walks the ChatGPT DOM and constructs a synthetic conversation payload in the
 * canonical mapping format. Returns null when the page has no conversation turns.
 */
export const buildDomConversationSnapshot = (conversationId: string): unknown | null => {
    const turns = findConversationTurns();
    if (turns.length === 0) {
        return null;
    }

    const mapping: Record<string, any> = {
        root: { id: 'root', message: null, parent: null, children: [] },
    };
    const now = Math.floor(Date.now() / 1000);
    let parentId = 'root';
    let index = 0;
    let lastModelSlug: string | null = null;

    for (const turn of turns) {
        index += 1;
        const result = buildDomTurnNode(turn, conversationId, index, parentId, now);
        if (!result) {
            index -= 1;
            continue;
        }
        if (result.modelSlug) {
            lastModelSlug = result.modelSlug;
        }
        mapping[result.messageId] = result.node;
        mapping[parentId].children.push(result.messageId);
        parentId = result.messageId;
    }

    if (parentId === 'root') {
        return null;
    }

    return {
        title: normalizeDomTitle(document.title || ''),
        create_time: now,
        update_time: now + index,
        mapping,
        conversation_id: conversationId,
        current_node: parentId,
        moderation_results: [],
        plugin_ids: null,
        gizmo_id: null,
        gizmo_type: null,
        is_archived: false,
        default_model_slug: lastModelSlug || 'unknown',
        safe_urls: [],
        blocked_urls: [],
    };
};
