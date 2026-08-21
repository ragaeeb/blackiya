import type { ConversationData, Message, MessageNode } from '@/utils/types';

export const HARNESS_CONVERSATION_ID = '6a875695-fe84-83ea-a27e-632934e225b7';
export const HARNESS_AUTHORIZATION = 'Bearer harness-test-token';

export type HarnessResponseMode = 'success' | 'not-terminal' | 'multimodal';

export const isValidHarnessAuthorization = (authorization: string | null | undefined): boolean =>
    authorization === HARNESS_AUTHORIZATION;

const createMessage = (
    id: string,
    role: Message['author']['role'],
    text: string,
    endTurn: boolean,
    timestamp: number,
    status: Message['status'] = 'finished_successfully',
    content: Message['content'] = { content_type: 'text', parts: [text] },
): Message => ({
    id,
    author: { role, name: null, metadata: {} },
    create_time: timestamp,
    update_time: timestamp,
    content,
    status,
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
 * Returns a deliberately small ChatGPT history payload. The non-terminal
 * variant is used by the browser test to prove that Save JSON fails closed.
 */
export const createHarnessConversationPayload = (
    conversationId: string = HARNESS_CONVERSATION_ID,
    mode: HarnessResponseMode = 'success',
): ConversationData => {
    const rootId = `harness-root-${conversationId}`;
    const userId = `harness-user-${conversationId}`;
    const assistantId = `harness-assistant-${conversationId}`;
    const terminal = mode !== 'not-terminal';
    const assistantContent: Message['content'] =
        mode === 'multimodal'
            ? ({
                  content_type: 'multimodal_text',
                  parts: [{ content_type: 'image_asset_pointer', asset_pointer: 'harness-image' }],
              })
            : { content_type: 'text', parts: ['The evaluation is complete. The final result is ready to save.'] };

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
                    terminal,
                    1760000060,
                    terminal ? 'finished_successfully' : 'in_progress',
                    assistantContent,
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

export const simulateChatGPTArtifactDownload = (document: Document) => {
    const pageOwnedHost = document.querySelector('#harness-model-switcher');
    if (!pageOwnedHost) {
        throw new Error('Harness page-owned host is missing');
    }

    const replacementHost = document.createElement('div');
    replacementHost.id = 'harness-model-switcher';
    replacementHost.setAttribute('data-harness-replaced', 'true');

    const extensionControls = document.querySelector<HTMLElement>('[data-blackiya-export-controls="1"]');
    if (extensionControls) {
        replacementHost.appendChild(extensionControls);
    }
    pageOwnedHost.replaceWith(replacementHost);

    const artifactPreview = document.querySelector<HTMLElement>('#harness-artifact-preview');
    if (!artifactPreview) {
        throw new Error('Harness artifact preview is missing');
    }
    artifactPreview.hidden = false;
    artifactPreview.setAttribute('data-harness-open', 'true');
};
