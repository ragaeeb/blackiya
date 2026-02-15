import { describe, expect, it } from 'bun:test';
import { BufferedStreamDumpStorage } from '@/utils/diagnostics-stream-dump';
import { STORAGE_KEYS } from '@/utils/settings';

function createMemoryStorage() {
    const store = new Map<string, unknown>();
    return {
        async get(key: string) {
            return { [key]: store.get(key) };
        },
        async set(value: Record<string, unknown>) {
            for (const [k, v] of Object.entries(value)) {
                store.set(k, v);
            }
        },
        async remove(key: string) {
            store.delete(key);
        },
    };
}

describe('diagnostics-stream-dump', () => {
    it('stores bounded frames grouped by attempt', async () => {
        const backend = createMemoryStorage();
        const storage = new BufferedStreamDumpStorage(backend, {
            flushThreshold: 1,
            maxFramesPerSession: 2,
        });

        await storage.saveFrame({
            platform: 'ChatGPT',
            attemptId: 'a1',
            conversationId: 'c1',
            kind: 'snapshot',
            text: 'first',
        });
        await storage.saveFrame({
            platform: 'ChatGPT',
            attemptId: 'a1',
            conversationId: 'c1',
            kind: 'snapshot',
            text: 'second',
        });
        await storage.saveFrame({
            platform: 'ChatGPT',
            attemptId: 'a1',
            conversationId: 'c1',
            kind: 'snapshot',
            text: 'third',
        });

        const dump = await storage.getStore();
        expect(dump.sessions.length).toBe(1);
        expect(dump.sessions[0]?.frameCount).toBe(3);
        expect(dump.sessions[0]?.frames.length).toBe(2);
        expect(dump.sessions[0]?.frames[0]?.text).toBe('second');
        expect(dump.sessions[0]?.truncated).toBe(true);
    });

    it('redacts sensitive token-like values in frame text', async () => {
        const backend = createMemoryStorage();
        const storage = new BufferedStreamDumpStorage(backend, { flushThreshold: 1 });
        await storage.saveFrame({
            platform: 'ChatGPT',
            attemptId: 'a1',
            kind: 'heuristic',
            text: 'authorization=Bearer abcdefghijklmnopqrstuvwxyz',
        });

        const dump = await storage.getStore();
        const text = dump.sessions[0]?.frames[0]?.text ?? '';
        expect(text).not.toContain('abcdefghijklmnopqrstuvwxyz');
        expect(text).toContain('<redacted>');
    });

    it('caps session count and clears storage', async () => {
        const backend = createMemoryStorage();
        const storage = new BufferedStreamDumpStorage(backend, {
            flushThreshold: 1,
            maxSessions: 2,
        });

        await storage.saveFrame({ platform: 'ChatGPT', attemptId: 'a1', kind: 'delta', text: 'one', timestampMs: 1 });
        await storage.saveFrame({ platform: 'ChatGPT', attemptId: 'a2', kind: 'delta', text: 'two', timestampMs: 2 });
        await storage.saveFrame({
            platform: 'ChatGPT',
            attemptId: 'a3',
            kind: 'delta',
            text: 'three',
            timestampMs: 3,
        });

        const dump = await storage.getStore();
        expect(dump.sessions.length).toBe(2);
        expect(dump.sessions.some((s) => s.attemptId === 'a3')).toBe(true);

        await storage.clearStore();
        const raw = await backend.get(STORAGE_KEYS.DIAGNOSTICS_STREAM_DUMP_STORE);
        expect(raw[STORAGE_KEYS.DIAGNOSTICS_STREAM_DUMP_STORE]).toBeUndefined();
    });
});
