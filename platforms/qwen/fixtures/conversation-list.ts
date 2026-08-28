import { QWEN_FIXTURE_CONVERSATION_ID } from './conversation-detail';

export const createQwenConversationListFixture = () => ({
    success: true,
    request_id: 'fixture-list-request',
    data: [
        {
            id: QWEN_FIXTURE_CONVERSATION_ID,
            title: 'Synthetic Qwen Conversation',
            chat_type: 't2t',
            created_at: 1_700_000_000,
            updated_at: 1_700_000_002,
            pinned: false,
            project_id: null,
        },
    ],
});
