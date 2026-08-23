export const SYNTHETIC_DEEPSEEK_CONVERSATION_ID = '11111111-1111-4111-8111-111111111111';

export const SYNTHETIC_DEEPSEEK_HISTORY_URL =
    `https://chat.deepseek.com/api/v0/chat/history_messages?chat_session_id=${SYNTHETIC_DEEPSEEK_CONVERSATION_ID}` +
    '&cache_version=7&cache_reset_at=1700000000';

const syntheticDeepSeekHistoryResponse = {
    code: 0,
    msg: 'synthetic-success',
    data: {
        biz_code: 0,
        biz_msg: 'synthetic-success',
        biz_data: {
            cache_control: 'synthetic-cache-control',
            chat_session: {
                id: SYNTHETIC_DEEPSEEK_CONVERSATION_ID,
                title: 'Synthetic DeepSeek Conversation',
                title_type: 'SYSTEM',
                current_message_id: 202,
                inserted_at: 1_700_000_000,
                updated_at: 1_700_000_020,
                is_empty: false,
                model_type: 'synthetic-model',
                agent: 'chat',
                pinned: false,
                seq_id: 2,
                version: 7,
                canonical_session_field: { retained: true },
            },
            chat_messages: [
                {
                    message_id: 101,
                    parent_id: 0,
                    role: 'USER',
                    status: 'FINISHED',
                    inserted_at: 1_700_000_001,
                    model: 'synthetic-model',
                    fragments: [{ id: 1, type: 'REQUEST', content: 'Synthetic user prompt.' }],
                    accumulated_token_usage: 4,
                    auto_continue: false,
                    ban_edit: false,
                    ban_regenerate: false,
                    feedback: null,
                    has_pending_fragment: false,
                    incomplete_message: null,
                    search_enabled: false,
                    search_triggered: false,
                    thinking_enabled: false,
                    canonical_message_field: { retained: 'user' },
                },
                {
                    message_id: 202,
                    parent_id: 101,
                    role: 'ASSISTANT',
                    status: 'FINISHED',
                    inserted_at: 1_700_000_010,
                    model: 'synthetic-model',
                    fragments: [
                        {
                            id: 2,
                            type: 'THINK',
                            content: 'Synthetic reasoning summary.',
                            elapsed_secs: 1,
                            stage_id: 1,
                            references: [],
                        },
                        {
                            id: 3,
                            type: 'RESPONSE',
                            content: 'Synthetic terminal answer.',
                            stage_id: 2,
                            references: [],
                        },
                    ],
                    accumulated_token_usage: 12,
                    auto_continue: false,
                    ban_edit: false,
                    ban_regenerate: false,
                    feedback: null,
                    has_pending_fragment: false,
                    incomplete_message: null,
                    search_enabled: false,
                    search_triggered: false,
                    thinking_enabled: true,
                    canonical_message_field: { retained: 'assistant' },
                },
            ],
            canonical_top_level_field: { retained: ['branch-a', 'branch-b'] },
        },
    },
};

export const createSyntheticDeepSeekHistoryResponse = () => structuredClone(syntheticDeepSeekHistoryResponse);
