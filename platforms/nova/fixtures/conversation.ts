import type { RawConversationPayload } from '@/utils/types';

export const NOVA_CONVERSATION_ID = '11111111-1111-4111-8111-111111111111';
export const NOVA_OTHER_CONVERSATION_ID = '22222222-2222-4222-8222-222222222222';

type NovaFixtureOptions = {
    assistantStatus?: string | null;
    interactionStatus?: string | null;
    deepResearchStatus?: string | null;
    assistantContent?: RawConversationPayload[];
    secondConversationId?: string | null;
};

const withOptionalString = (record: Record<string, RawConversationPayload>, key: string, value: string | null) => {
    if (value !== null) {
        record[key] = value;
    }
};

export const createNovaConversationFixture = (options: NovaFixtureOptions = {}): RawConversationPayload => {
    const assistantStatus = options.assistantStatus === undefined ? 'success' : options.assistantStatus;
    const interactionStatus = options.interactionStatus === undefined ? 'success' : options.interactionStatus;
    const assistantContent = options.assistantContent ?? [
        {
            text: '[sanitized terminal response]',
            contentId: 'content-assistant-1',
            type: 'text',
        },
    ];

    const assistantMessage: Record<string, RawConversationPayload> = {
        role: 'assistant',
        content: assistantContent,
    };
    withOptionalString(assistantMessage, 'status', assistantStatus);

    const firstInteraction: Record<string, RawConversationPayload> = {
        conversationId: NOVA_CONVERSATION_ID,
        interactionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        interactionStartTime: '2026-08-23T12:00:00.000Z',
        conversationTitle: 'Sanitized Nova conversation',
        modelId: 'amazon.nova.synthetic-v1:0',
        messages: [
            {
                role: 'user',
                status: 'success',
                content: [
                    {
                        text: '[sanitized user prompt]',
                        contentId: 'content-user-1',
                        type: 'text',
                    },
                ],
            },
            assistantMessage,
        ],
        citations: [
            {
                title: 'Synthetic source',
                url: 'https://example.invalid/source',
            },
        ],
        reasoningConfig: {
            selectedReasoningEffort: 'synthetic',
        },
    };
    withOptionalString(firstInteraction, 'status', interactionStatus);
    withOptionalString(firstInteraction, 'deepResearchStatus', options.deepResearchStatus ?? null);

    const conversationInteractions: RawConversationPayload[] = [firstInteraction];
    if (options.secondConversationId) {
        conversationInteractions.push({
            conversationId: options.secondConversationId,
            interactionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            interactionStartTime: '2026-08-23T12:01:00.000Z',
            status: 'success',
            messages: [],
        });
    }

    return {
        conversationInteractions,
        canonicalMetadata: {
            capture: 'sanitized-har-derived',
            branch: {
                id: 'synthetic-branch',
                retained: true,
            },
        },
    };
};

export const terminalNovaConversation = createNovaConversationFixture();

export const pendingNovaConversation = createNovaConversationFixture({
    assistantStatus: 'in_progress',
    interactionStatus: 'in_progress',
});

export const pendingDeepResearchNovaConversation = createNovaConversationFixture({
    deepResearchStatus: 'in_progress',
});

export const statuslessNovaConversation = createNovaConversationFixture({
    assistantStatus: null,
    interactionStatus: null,
});

export const failedNovaConversation = createNovaConversationFixture({
    assistantStatus: 'failed',
    interactionStatus: 'failed',
});

export const terminalArtifactNovaConversation = createNovaConversationFixture({
    assistantContent: [
        {
            type: 'artifact',
            artifact: {
                artifactId: 'synthetic-artifact',
                artifactType: 'code',
            },
        },
    ],
});
