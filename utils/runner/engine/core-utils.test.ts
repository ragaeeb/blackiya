import { describe, expect, it, mock } from 'bun:test';
import { ingestStabilizationRetrySnapshot } from '@/utils/runner/engine/core-utils';
import type { EngineCtx } from '@/utils/runner/engine/types';
import type { ConversationData } from '@/utils/types';

const buildCtx = () => {
    const ingestConversationData = mock((_data: ConversationData, _source: string) => {});
    const ingestInterceptedData = mock((_args: { url: string; data: string; platform: string }) => {});
    const ctx = {
        currentAdapter: { name: 'ChatGPT' },
        interceptionManager: {
            ingestConversationData,
            ingestInterceptedData,
        },
    } as unknown as EngineCtx;
    return { ctx, ingestConversationData, ingestInterceptedData };
};

describe('ingestStabilizationRetrySnapshot', () => {
    it('should ingest conversation-like snapshots via direct conversation ingest', () => {
        const { ctx, ingestConversationData, ingestInterceptedData } = buildCtx();
        const snapshot = {
            conversation_id: 'conv-1',
            title: 'Conversation',
            mapping: {
                root: { id: 'root', message: null, parent: null, children: [] },
            },
        } as unknown as ConversationData;

        ingestStabilizationRetrySnapshot(ctx, 'conv-1', snapshot);

        expect(ingestConversationData).toHaveBeenCalledWith(snapshot, 'stabilization-retry-snapshot');
        expect(ingestInterceptedData).not.toHaveBeenCalled();
    });

    it('should replay raw-capture snapshots using original url/data', () => {
        const { ctx, ingestConversationData, ingestInterceptedData } = buildCtx();
        const rawSnapshot = {
            __blackiyaSnapshotType: 'raw-capture',
            conversationId: 'conv-1',
            url: 'https://chatgpt.com/backend-api/f/conversation/conv-1',
            data: '{"conversation":{"id":"conv-1"}}',
            platform: 'ChatGPT',
        };

        ingestStabilizationRetrySnapshot(ctx, 'conv-1', rawSnapshot);

        expect(ingestConversationData).not.toHaveBeenCalled();
        expect(ingestInterceptedData).toHaveBeenCalledWith({
            url: 'https://chatgpt.com/backend-api/f/conversation/conv-1',
            data: '{"conversation":{"id":"conv-1"}}',
            platform: 'ChatGPT',
        });
    });
});
