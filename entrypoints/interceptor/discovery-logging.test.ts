import { describe, expect, it, mock } from 'bun:test';
import { logAdapterEndpointMiss } from '@/entrypoints/interceptor/discovery-logging';

const withHostname = (hostname: string, callback: () => void) => {
    const originalWindow = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {
        location: {
            hostname,
            origin: `https://${hostname}`,
        },
    };

    try {
        callback();
    } finally {
        (globalThis as { window?: unknown }).window = originalWindow;
    }
};

describe('discovery endpoint miss diagnostics', () => {
    it('should log a Gemini endpoint miss when a Gemini data path is unmatched by adapters', () => {
        const log = mock(() => {});
        const shouldLogTransient = mock(() => true);

        withHostname('gemini.google.com', () => {
            logAdapterEndpointMiss(
                'fetch',
                'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/UnknownRpc?rt=c',
                undefined,
                log,
                shouldLogTransient,
            );
        });

        expect(shouldLogTransient).toHaveBeenCalledWith(
            'adapter-miss:gemini:fetch:/_/BardChatUi/data/assistant.lamda.BardFrontendService/UnknownRpc',
            8000,
        );
        expect(log).toHaveBeenCalledWith(
            'warn',
            'Gemini endpoint unmatched by adapter',
            expect.objectContaining({
                path: '/_/BardChatUi/data/assistant.lamda.BardFrontendService/UnknownRpc',
            }),
        );
    });

    it('should log a ChatGPT endpoint miss when backend-api path is unmatched by adapters', () => {
        const log = mock(() => {});
        const shouldLogTransient = mock(() => true);

        withHostname('chatgpt.com', () => {
            logAdapterEndpointMiss(
                'fetch',
                'https://chatgpt.com/backend-api/textdocs/something',
                undefined,
                log,
                shouldLogTransient,
            );
        });

        expect(log).toHaveBeenCalledWith(
            'warn',
            'ChatGPT endpoint unmatched by adapter',
            expect.objectContaining({ path: '/backend-api/textdocs/something' }),
        );
    });

    it('should log a Grok endpoint miss when Grok API-like paths are unmatched by adapters', () => {
        const log = mock(() => {});
        const shouldLogTransient = mock(() => true);

        withHostname('x.com', () => {
            logAdapterEndpointMiss(
                'xhr',
                'https://x.com/i/api/graphql/abc123/UnknownOperation?variables=%7B%7D',
                { method: 'POST', status: 200 },
                log,
                shouldLogTransient,
            );
        });

        expect(log).toHaveBeenCalledWith(
            'warn',
            'Grok endpoint unmatched by adapter',
            expect.objectContaining({
                path: '/i/api/graphql/abc123/UnknownOperation',
                method: 'POST',
                status: 200,
            }),
        );
    });

    it('should not log when the URL is unrelated to known platform API families', () => {
        const log = mock(() => {});
        const shouldLogTransient = mock(() => true);

        withHostname('chatgpt.com', () => {
            logAdapterEndpointMiss('fetch', 'https://chatgpt.com/assets/app.js', undefined, log, shouldLogTransient);
        });

        expect(log).toHaveBeenCalledTimes(0);
        expect(shouldLogTransient).toHaveBeenCalledTimes(0);
    });
});
