const extractTurnRole = (turn: Element): 'system' | 'user' | 'assistant' | 'tool' | null => {
    const role = turn.querySelector('[data-message-author-role]')?.getAttribute('data-message-author-role');
    if (role === 'system' || role === 'user' || role === 'assistant' || role === 'tool') {
        return role;
    }
    return null;
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
    if (thoughtFragments.length > 0 && text.length === 0) {
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

    for (const turn of turns) {
        const role = extractTurnRole(turn);
        if (!role) {
            continue;
        }

        const text = extractTurnText(turn);
        const thoughtFragments = extractThoughtFragments(turn);
        if (!text && thoughtFragments.length === 0) {
            continue;
        }

        index += 1;
        const messageId = `dom-${conversationId}-${index}`;
        const content = buildDomMessageContent(text, thoughtFragments);
        const metadata = thoughtFragments.length > 0 ? { reasoning: thoughtFragments.join('\n\n') } : {};

        mapping[messageId] = {
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
        };
        mapping[parentId].children.push(messageId);
        parentId = messageId;
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
        default_model_slug: 'unknown',
        safe_urls: [],
        blocked_urls: [],
    };
};
