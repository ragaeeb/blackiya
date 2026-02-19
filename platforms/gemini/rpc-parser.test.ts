import { describe, expect, it, mock } from 'bun:test';

mock.module('@/utils/logger', () => ({
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

import { findConversationRpc } from './rpc-parser';

describe('Gemini rpc-parser', () => {
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
