import type { ConversationData, Message, MessageNode } from '@/utils/types';

export const HARNESS_CONVERSATION_ID = '6a875695-fe84-83ea-a27e-632934e225b7';

/**
 * Reproduces the ChatGPT artifact preview transition used by the browser
 * harness. Opening a downloadable file replaces page-owned header controls
 * while keeping the conversation document alive.
 */
export const simulateChatGPTArtifactDownload = (document: Document) => {
    const pageOwnedHost = document.querySelector<HTMLElement>('#harness-model-switcher');
    if (!pageOwnedHost) {
        throw new Error('Harness page-owned host is missing');
    }

    const replacementHost = document.createElement('div');
    replacementHost.id = 'harness-model-switcher';
    replacementHost.setAttribute('data-harness-replaced', 'true');
    pageOwnedHost.replaceWith(replacementHost);

    const artifactPreview = document.querySelector<HTMLElement>('#harness-artifact-preview');
    if (!artifactPreview) {
        throw new Error('Harness artifact preview is missing');
    }
    artifactPreview.hidden = false;
    artifactPreview.setAttribute('data-harness-open', 'true');
};

const createMessage = (
    id: string,
    role: Message['author']['role'],
    text: string,
    endTurn: boolean,
    timestamp: number,
): Message => ({
    id,
    author: { role, name: null, metadata: {} },
    create_time: timestamp,
    update_time: timestamp,
    content: { content_type: 'text', parts: [text] },
    status: 'finished_successfully',
    end_turn: endTurn,
    weight: 1,
    metadata: {},
    recipient: 'all',
    channel: role === 'assistant' ? 'final' : null,
});

const createNode = (id: string, message: Message | null, parent: string | null, children: string[]): MessageNode => ({
    id,
    message,
    parent,
    children,
});

/**
 * Returns a deliberately small, finished ChatGPT history payload.
 * The browser harness serves this through a local backend-api route so the
 * real adapter parser and warm-fetch path can consume it.
 */
export const createHarnessConversationPayload = (
    conversationId: string = HARNESS_CONVERSATION_ID,
): ConversationData => {
    const rootId = `harness-root-${conversationId}`;
    const userId = `harness-user-${conversationId}`;
    const assistantId = `harness-assistant-${conversationId}`;

    return {
        title: 'Bootstrap Mewzimen Evaluator',
        create_time: 1760000000,
        update_time: 1760000060,
        mapping: {
            [rootId]: createNode(rootId, null, null, [userId]),
            [userId]: createNode(
                userId,
                createMessage(
                    userId,
                    'user',
                    'Please summarize the completed evaluation and explain the result.',
                    false,
                    1760000005,
                ),
                rootId,
                [assistantId],
            ),
            [assistantId]: createNode(
                assistantId,
                createMessage(
                    assistantId,
                    'assistant',
                    'The evaluation is complete. The final result is ready to save.',
                    true,
                    1760000060,
                ),
                userId,
                [],
            ),
        },
        conversation_id: conversationId,
        current_node: assistantId,
        moderation_results: [],
        plugin_ids: null,
        gizmo_id: null,
        gizmo_type: null,
        is_archived: false,
        default_model_slug: 'gpt-5',
        safe_urls: [],
        blocked_urls: [],
    };
};
