export const SYNTHETIC_META_CONVERSATION_ID = '11111111-1111-4111-8111-111111111111';

export const SYNTHETIC_META_INTERNAL_ID = 'synthetic-internal-conversation';

type DetailFixtureOptions = {
    assistantContent?: string;
    assistantError?: Record<string, unknown> | null;
    assistantStructuredContent?: Record<string, unknown>;
    assistantStreamingState?: string;
    hasPreviousPage?: boolean;
    includeStructuredContent?: boolean;
};

export const createMetaDetailFixture = ({
    assistantContent = 'Synthetic terminal answer.',
    assistantError = null,
    assistantStructuredContent = {
        __typename: 'XMSGGenAIUnifiedResponse',
        response_id: 'synthetic-unified-response',
        sections: [
            {
                __typename: 'GenAIUnifiedResponseSection',
                header: null,
                view_model: {
                    __typename: 'GenAISingleLayoutViewModel',
                },
            },
        ],
        embedded_screens: [],
        footer_sections: null,
        nested_responses: null,
    },
    assistantStreamingState = 'DONE',
    hasPreviousPage = false,
    includeStructuredContent = true,
}: DetailFixtureOptions = {}) => ({
    data: {
        conversation: {
            __isConversationBase: 'Conversation',
            id: SYNTHETIC_META_CONVERSATION_ID,
            conversationId: SYNTHETIC_META_INTERNAL_ID,
            title: 'Synthetic Meta Muse Conversation',
            displayTitle: 'Synthetic Meta Muse Conversation',
            updatedAt: '2026-08-23T14:02:00.000Z',
            type: 'CHAT',
            latestBranchPath: 'synthetic-latest-branch',
            messages: {
                edges: [
                    {
                        cursor: 'synthetic-user-cursor',
                        node: {
                            __typename: 'UserMessage',
                            __isMessage: 'UserMessage',
                            id: 'synthetic-user-message',
                            conversationId: SYNTHETIC_META_CONVERSATION_ID,
                            content: 'Synthetic question.',
                            userContent: 'Synthetic question.',
                            createdAt: '2026-08-23T14:01:00.000Z',
                            userCreatedAt: '2026-08-23T14:01:00.000Z',
                            branchPath: 'synthetic-user-branch',
                            error: null,
                        },
                    },
                    {
                        cursor: 'synthetic-assistant-cursor',
                        node: {
                            __typename: 'AssistantMessage',
                            __isMessage: 'AssistantMessage',
                            id: 'synthetic-assistant-message',
                            conversationId: SYNTHETIC_META_CONVERSATION_ID,
                            content: assistantContent,
                            createdAt: '2026-08-23T14:02:00.000Z',
                            assistantCreatedAt: '2026-08-23T14:02:00.000Z',
                            branchPath: 'synthetic-assistant-branch',
                            streamingState: assistantStreamingState,
                            error: assistantError,
                            contentRenderer: {
                                __typename: 'UnifiedResponseContentRenderer',
                                hasReceivedUnifiedResponse: includeStructuredContent,
                                message: {
                                    id: 'synthetic-renderer-message',
                                    conversationId: SYNTHETIC_META_CONVERSATION_ID,
                                    uniqueMessageId: 'synthetic-renderer-unique-message',
                                    content: assistantContent,
                                    sources: [],
                                    streamingState: assistantStreamingState,
                                },
                                unified_response: includeStructuredContent ? assistantStructuredContent : null,
                            },
                        },
                    },
                ],
                pageInfo: {
                    hasPreviousPage,
                    startCursor: hasPreviousPage ? 'synthetic-before-cursor' : null,
                },
            },
            pinned: false,
            snapshotId: null,
            viewerActions: [],
            viewerActionsLive: [],
            wearableSurface: null,
        },
        conversationModePreference: {
            lastSelectedMode: 'synthetic-mode',
        },
    },
});

export const createMetaOlderPageFixture = (conversationId = SYNTHETIC_META_CONVERSATION_ID) => ({
    data: {
        conversation: {
            id: conversationId,
            isUnread: false,
            latestBranchPath: null,
            messages: {
                edges: [
                    {
                        cursor: 'synthetic-older-cursor',
                        node: {
                            __typename: 'AssistantMessage',
                            __isMessage: 'AssistantMessage',
                            id: 'synthetic-older-assistant-message',
                            conversationId,
                            content: 'Synthetic older answer.',
                            createdAt: '2026-08-23T14:00:00.000Z',
                            assistantCreatedAt: '2026-08-23T14:00:00.000Z',
                            branchPath: 'synthetic-older-branch',
                            streamingState: 'DONE',
                            error: null,
                        },
                    },
                ],
                pageInfo: {
                    hasPreviousPage: false,
                    startCursor: null,
                },
            },
        },
    },
});
