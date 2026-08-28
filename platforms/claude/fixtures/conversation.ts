export const SYNTHETIC_ORGANIZATION_ID = '10000000-0000-4000-8000-000000000001';
export const SYNTHETIC_CONVERSATION_ID = '20000000-0000-4000-8000-000000000002';
export const SYNTHETIC_USER_MESSAGE_ID = '30000000-0000-4000-8000-000000000003';
export const SYNTHETIC_ASSISTANT_MESSAGE_ID = '40000000-0000-4000-8000-000000000004';

export const CLAUDE_DETAIL_URL =
    `https://claude.ai/api/organizations/${SYNTHETIC_ORGANIZATION_ID}` +
    `/chat_conversations/${SYNTHETIC_CONVERSATION_ID}` +
    '?tree=true&rendering_mode=messages&render_all_tools=true&consistency=strong';

export const CLAUDE_CURRENT_DETAIL_URL =
    `https://claude.ai/api/organizations/${SYNTHETIC_ORGANIZATION_ID}` +
    `/chat_conversations/${SYNTHETIC_CONVERSATION_ID}` +
    '?tree=True&rendering_mode=messages&render_all_tools=true&include_inline_comparison=true&consistency=strong';

export type ClaudeFixtureContentBlock = {
    type: string;
    [key: string]: unknown;
};

export type ClaudeFixtureMessage = {
    uuid: string;
    parent_message_uuid: string | null;
    index: number;
    sender: string;
    content: ClaudeFixtureContentBlock[];
    text: string;
    attachments: unknown[];
    files: unknown[];
    sync_sources: unknown[];
    truncated: boolean;
    stop_reason?: string | null;
    created_at: string;
    updated_at: string;
};

export type ClaudeFixturePayload = {
    uuid: string;
    name: string;
    summary: string;
    created_at: string;
    updated_at: string;
    current_leaf_message_uuid: string;
    model: string;
    platform: string;
    is_starred: boolean;
    is_temporary: boolean;
    is_wiggle_enabled: boolean;
    effective_thinking_mode: string;
    settings: Record<string, unknown>;
    chat_messages: ClaudeFixtureMessage[];
};

export const createClaudeTerminalPayload = (): ClaudeFixturePayload => ({
    uuid: SYNTHETIC_CONVERSATION_ID,
    name: 'Synthetic terminal conversation',
    summary: 'Synthetic summary',
    created_at: '2026-08-01T12:00:00.000Z',
    updated_at: '2026-08-01T12:01:00.000Z',
    current_leaf_message_uuid: SYNTHETIC_ASSISTANT_MESSAGE_ID,
    model: 'claude-synthetic',
    platform: 'claude.ai',
    is_starred: false,
    is_temporary: false,
    is_wiggle_enabled: false,
    effective_thinking_mode: 'enabled',
    settings: {
        effort_level: 'high',
        enabled_monkeys_in_a_barrel: false,
        enabled_saffron: false,
        enabled_turmeric: false,
        enabled_web_search: true,
        paprika_mode: 'none',
        preview_feature_uses_artifacts: true,
        thinking_mode: 'enabled',
        tool_search_mode: 'auto',
    },
    chat_messages: [
        {
            uuid: SYNTHETIC_USER_MESSAGE_ID,
            parent_message_uuid: null,
            index: 0,
            sender: 'human',
            content: [
                {
                    type: 'text',
                    text: 'Synthetic user prompt.',
                    citations: [],
                    start_timestamp: '2026-08-01T12:00:00.000Z',
                    stop_timestamp: '2026-08-01T12:00:01.000Z',
                },
            ],
            text: '',
            attachments: [],
            files: [],
            sync_sources: [],
            truncated: false,
            created_at: '2026-08-01T12:00:00.000Z',
            updated_at: '2026-08-01T12:00:01.000Z',
        },
        {
            uuid: SYNTHETIC_ASSISTANT_MESSAGE_ID,
            parent_message_uuid: SYNTHETIC_USER_MESSAGE_ID,
            index: 1,
            sender: 'assistant',
            content: [
                {
                    type: 'thinking',
                    thinking: '',
                    summaries: [],
                    hidden: false,
                    thinking_hidden: false,
                    cut_off: false,
                    truncated: false,
                    start_timestamp: '2026-08-01T12:00:02.000Z',
                    stop_timestamp: '2026-08-01T12:00:03.000Z',
                },
                {
                    type: 'tool_use',
                    id: 'synthetic-tool-use-1',
                    name: 'synthetic_search',
                    input: { query: 'synthetic query' },
                    message: 'Synthetic tool invocation.',
                    icon_name: 'search',
                    start_timestamp: '2026-08-01T12:00:04.000Z',
                    stop_timestamp: '2026-08-01T12:00:05.000Z',
                },
                {
                    type: 'tool_result',
                    tool_use_id: 'synthetic-tool-use-1',
                    name: 'synthetic_search',
                    content: [{ type: 'text', text: 'Synthetic tool result.' }],
                    is_error: false,
                    icon_name: 'search',
                    start_timestamp: '2026-08-01T12:00:05.000Z',
                    stop_timestamp: '2026-08-01T12:00:06.000Z',
                },
                {
                    type: 'text',
                    text: 'Synthetic final answer.',
                    citations: [],
                    citations_grouping_mode: 'grouped',
                    start_timestamp: '2026-08-01T12:00:07.000Z',
                    stop_timestamp: '2026-08-01T12:01:00.000Z',
                },
            ],
            text: '',
            attachments: [],
            files: [],
            sync_sources: [],
            truncated: false,
            stop_reason: 'end_turn',
            created_at: '2026-08-01T12:00:02.000Z',
            updated_at: '2026-08-01T12:01:00.000Z',
        },
    ],
});

export const createClaudeDeepResearchPayload = (): ClaudeFixturePayload => {
    const payload = createClaudeTerminalPayload();
    payload.chat_messages[0]!.parent_message_uuid = '00000000-0000-4000-8000-000000000000';
    payload.chat_messages[0]!.content[0]!.text =
        'Research this systematically, starting with identifying the evidence.';
    payload.chat_messages[1]!.stop_reason = 'stop_sequence';
    payload.chat_messages[1]!.content = [
        {
            type: 'thinking',
            thinking: 'Substantial, well-triangulated evidence across the relevant sources.',
            summaries: [],
            hidden: false,
            thinking_hidden: false,
            cut_off: false,
            truncated: false,
        },
        {
            type: 'tool_result',
            tool_use_id: 'synthetic-tool-use-1',
            name: 'synthetic_search',
            content: [{ type: 'text', text: 'https://docs.fallow.tools/cli/schema.md' }],
            is_error: false,
        },
        { type: 'text', text: 'Sanitized final research answer.', citations: [] },
    ];
    return payload;
};
