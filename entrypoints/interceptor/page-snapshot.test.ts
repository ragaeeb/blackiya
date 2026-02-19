import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Window } from 'happy-dom';

import { getPageConversationSnapshot } from './page-snapshot';

describe('page-snapshot global scanning', () => {
    let windowInstance: Window;

    beforeEach(() => {
        windowInstance = new Window();
        (globalThis as any).window = windowInstance;
        (globalThis as any).document = windowInstance.document;
    });

    afterEach(async () => {
        if (typeof (windowInstance as any)?.close === 'function') {
            (windowInstance as any).close();
        } else if (typeof (windowInstance as any)?.happyDOM?.close === 'function') {
            await (windowInstance as any).happyDOM.close();
        }
        delete (globalThis as any).window;
        delete (globalThis as any).document;
    });

    it('should keep scanning when a global object has getter-backed properties that throw', () => {
        const throwingRoot: Record<string, unknown> = {};
        Object.defineProperty(throwingRoot, 'boom', {
            enumerable: true,
            configurable: true,
            get() {
                throw new Error('getter failure');
            },
        });

        (windowInstance as any).__NEXT_DATA__ = throwingRoot;
        (windowInstance as any).__remixContext = {
            conversation: {
                conversation_id: 'conv-123',
                title: 'Recovered from later global',
                mapping: {},
            },
        };

        const snapshot = getPageConversationSnapshot('conv-123', () => []);
        expect(snapshot).not.toBeNull();
        expect((snapshot as any)?.title).toBe('Recovered from later global');
    });

    it('should ignore raw-capture entries that only contain the conversation id as plain substring', () => {
        const snapshot = getPageConversationSnapshot('conv-123', () => [
            {
                type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                url: 'https://chatgpt.com/backend-api/conversation',
                data: JSON.stringify({ note: 'debug conv-123 text only' }),
                platform: 'ChatGPT',
            } as any,
        ]);

        expect(snapshot).toBeNull();
    });

    it('should accept raw-capture entries with exact conversation key/value matches', () => {
        const snapshot = getPageConversationSnapshot('conv-123', () => [
            {
                type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                url: 'https://chatgpt.com/backend-api/conversation',
                data: JSON.stringify({ conversation_id: 'conv-123', note: 'exact match' }),
                platform: 'ChatGPT',
            } as any,
        ]);

        expect(snapshot).not.toBeNull();
        expect((snapshot as any)?.__blackiyaSnapshotType).toBe('raw-capture');
        expect((snapshot as any)?.conversationId).toBe('conv-123');
    });
});
