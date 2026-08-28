import type { ConversationData, Message, MessageNode } from '@/utils/types';

const CONVERSATION_ID = '11111111-1111-4111-8111-111111111111';

const createMessage = (id: string, role: Message['author']['role'], overrides: Partial<Message> = {}): Message => ({
    id,
    author: { role, name: null, metadata: {} },
    create_time: 1,
    update_time: 1,
    content: { content_type: 'text', parts: ['[sanitized]'] },
    status: 'finished_successfully',
    end_turn: null,
    weight: 1,
    metadata: {},
    recipient: 'all',
    channel: null,
    ...overrides,
});

const createDeepResearchConversation = (toolOverrides: Partial<Message> = {}): ConversationData => {
    const root: MessageNode = { id: 'root', message: null, parent: null, children: ['user-1'] };
    const user: MessageNode = {
        id: 'user-1',
        parent: 'root',
        children: ['assistant-code'],
        message: createMessage('user-1', 'user', {
            content: { content_type: 'text', parts: ['[sanitized research request]'] },
            end_turn: true,
            metadata: { can_save: false },
        }),
    };
    const assistantCode: MessageNode = {
        id: 'assistant-code',
        parent: 'user-1',
        children: ['tool-code'],
        message: createMessage('assistant-code', 'assistant', {
            content: { content_type: 'code', parts: [] },
            end_turn: false,
            metadata: {
                is_complete: true,
                message_type: 'next',
                can_save: false,
            },
        }),
    };
    const tool: MessageNode = {
        id: 'tool-code',
        parent: 'assistant-code',
        children: [],
        message: createMessage('tool-code', 'tool', {
            content: { content_type: 'code', parts: [] },
            end_turn: null,
            metadata: { message_type: 'next', can_save: false },
            ...toolOverrides,
        }),
    };

    return {
        title: 'Sanitized deep research thread',
        create_time: 1,
        update_time: 2,
        conversation_id: CONVERSATION_ID,
        current_node: 'tool-code',
        mapping: { root, 'user-1': user, 'assistant-code': assistantCode, 'tool-code': tool },
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

export const deepResearchCompletedConversation = createDeepResearchConversation();

export const deepResearchInProgressConversation = createDeepResearchConversation({
    status: 'in_progress',
});
