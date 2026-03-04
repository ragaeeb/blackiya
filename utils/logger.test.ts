import { beforeEach, describe, expect, it, mock } from 'bun:test';

const sentMessages: unknown[] = [];
const savedLogs: unknown[] = [];
let sendMessageImpl: (message: unknown) => Promise<unknown> = async () => ({ ok: true });

mock.module('wxt/browser', () => ({
    browser: {
        runtime: {
            sendMessage: (message: unknown) => {
                sentMessages.push(message);
                return sendMessageImpl(message);
            },
        },
        storage: {
            local: {
                get: async () => ({}),
            },
            onChanged: {
                addListener: () => {},
            },
        },
    },
}));

mock.module('./logs-storage', () => ({
    logsStorage: {
        saveLog: async (entry: unknown) => {
            savedLogs.push(entry);
        },
    },
}));

const importFreshLogger = async () =>
    import(`./logger.ts?logger-test=${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);

describe('logger', () => {
    beforeEach(() => {
        sentMessages.length = 0;
        savedLogs.length = 0;
        sendMessageImpl = async () => ({ ok: true });
    });

    it('should fallback to logsStorage when runtime messaging fails outside background context', async () => {
        const { logger } = await importFreshLogger();
        (logger as any).setLevel('debug');
        (logger as any).context = 'content';

        sendMessageImpl = async () => {
            throw new Error('runtime unavailable');
        };

        logger.info('message failure fallback', { foo: 'bar' });
        await Promise.resolve();
        await Promise.resolve();

        expect(sentMessages).toHaveLength(1);
        expect(savedLogs).toHaveLength(1);
        expect(savedLogs[0]).toMatchObject({
            message: 'message failure fallback',
            context: 'content',
        });
    });

    it('should sanitize non-serializable arguments before persisting logs', async () => {
        const { logger } = await importFreshLogger();
        (logger as any).setLevel('debug');
        (logger as any).context = 'background';

        const circular: Record<string, unknown> = { name: 'circular' };
        circular.self = circular;

        logger.warn('sanitize me', () => 'x', circular, BigInt(7));
        await Promise.resolve();

        expect(savedLogs).toHaveLength(1);
        const savedEntry = (savedLogs[0] ?? null) as { data?: unknown[]; context?: string } | null;
        if (!savedEntry) {
            throw new Error('expected saved log entry');
        }
        expect(savedEntry.context).toBe('background');
        expect(Array.isArray(savedEntry.data)).toBeTrue();
        expect(savedEntry.data?.[0]).toBe('[Function anonymous]');
        expect(savedEntry.data?.[1]).toEqual({
            name: 'circular',
            self: '[Circular]',
        });
        expect(savedEntry.data?.[2]).toBe('7n');
    });

    it('should sanitize invalid Date values without throwing', async () => {
        const { logger } = await importFreshLogger();
        (logger as any).setLevel('debug');
        (logger as any).context = 'background';

        logger.info('invalid date test', new Date('invalid'));
        await Promise.resolve();

        expect(savedLogs).toHaveLength(1);
        const savedEntry = (savedLogs[0] ?? null) as { data?: unknown[] } | null;
        if (!savedEntry) {
            throw new Error('expected saved log entry');
        }
        expect(savedEntry.data?.[0]).toBe('[Invalid Date]');
    });
});
