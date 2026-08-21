import { describe, expect, it, mock } from 'bun:test';
import { LRUCache } from '@/utils/lru-cache';

mock.module('@/utils/logger', () => ({
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

import { findConversationRpc } from './rpc-parser';
import { parseConversationPayload } from './conversation-parser';

describe('Gemini rpc-parser', () => {
    it('should preserve the complete canonical payload alongside the normalized view', () => {
        const payload = [
            [
                [
                    ['c_20de061ec5dae81c', 'conversation-metadata'],
                    null,
                    [['First user turn']],
                    [[['assistant-node', ['First assistant turn'], { branch: 'a' }]]],
                    { providerUnknown: ['branch-a', 'branch-b'] },
                ],
            ],
        ];

        const result = parseConversationPayload(payload, new LRUCache(10), new LRUCache(10));

        expect(result).not.toBeNull();
        expect((result as unknown as Record<string, unknown>).raw_payload).toEqual(payload);
        expect(result?.mapping).toHaveProperty('segment-0');
        expect(result?.mapping).toHaveProperty('segment-1');
    });

    it('should fall back to heuristic RPC parsing when no payload predicate is supplied', () => {
        const results = [
            { rpcId: 'mismatch-1', payload: '' },
            { rpcId: 'mismatch-2', payload: JSON.stringify({ foo: 'bar', conversation: 'heuristic' }) },
        ];

        const resolved = findConversationRpc(results as any);
        expect(resolved).not.toBeNull();
        expect(resolved?.rpcId).toBe('mismatch-2');
        expect(resolved?.payload).toEqual({ foo: 'bar', conversation: 'heuristic' });
    });
});
