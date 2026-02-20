import { describe, expect, it } from 'bun:test';
import { wireGrokXhrProgressMonitor } from './grok-lifecycle';

class FakeXhr {
    public responseText = '';
    private listeners = new Map<string, Set<() => void>>();

    public addEventListener(type: string, listener: () => void) {
        let set = this.listeners.get(type);
        if (!set) {
            set = new Set();
            this.listeners.set(type, set);
        }
        set.add(listener);
    }

    public removeEventListener(type: string, listener: () => void) {
        this.listeners.get(type)?.delete(listener);
    }

    public dispatch(type: string) {
        for (const listener of this.listeners.get(type) ?? []) {
            listener();
        }
    }
}

describe('grok-lifecycle xhr wiring', () => {
    it('should use provided requestUrl instead of xhr._url fallback for stream state', () => {
        const xhr = new FakeXhr();
        const logs: Array<{ message: string; data: any }> = [];

        const emit = {
            conversationIdResolved: () => {},
            lifecycle: () => {},
            streamDelta: () => {},
            streamDump: () => {},
            titleResolved: () => {},
            isAttemptDisposed: () => false,
            shouldLogTransient: () => true,
            log: (_level: 'info' | 'warn' | 'error', message: string, data?: unknown) => {
                logs.push({ message, data: data as any });
            },
        };

        wireGrokXhrProgressMonitor(
            xhr as any,
            'attempt-1',
            emit as any,
            'conv-1',
            'https://grok.com/rest/app-chat/conversations/conv-1/load-responses?foo=bar',
        );

        xhr.responseText = '{"responseId":"r1","message":"hello"}';
        xhr.dispatch('progress');
        xhr.dispatch('loadend');

        const completeLog = logs.find((entry) => entry.message === 'Grok XHR stream monitor complete');
        expect(completeLog).toBeDefined();
        expect(completeLog?.data?.path).not.toBe('/');
        expect(String(completeLog?.data?.path)).toContain('load-responses');
    });
});
