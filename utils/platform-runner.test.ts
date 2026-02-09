import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { Window } from 'happy-dom';

// Configure Happy DOM
const window = new Window();
const document = window.document;
(global as any).window = window;
(global as any).document = document;
(global as any).history = window.history;
(global as any).HTMLElement = window.HTMLElement;
(global as any).HTMLButtonElement = window.HTMLButtonElement;
(global as any).MutationObserver = window.MutationObserver;

// Mock dependencies
const mockAdapter = {
    name: 'TestPlatform',
    extractConversationId: () => '123',
    getButtonInjectionTarget: () => document.body,
    formatFilename: () => 'test.json',
    parseInterceptedData: () => ({ conversation_id: '123' }),
};

// We need a mutable reference to control the mock return value
let currentAdapterMock: any = mockAdapter;

// Mock the factory module
mock.module('@/platforms/factory', () => ({
    getPlatformAdapter: () => currentAdapterMock,
    getPlatformAdapterByApiUrl: () => currentAdapterMock,
}));

mock.module('@/utils/download', () => ({
    downloadAsJSON: () => {},
}));

// Mock wxt/browser explicitly for this test file to prevent logger errors
const browserMock = {
    storage: {
        local: {
            get: async () => ({}),
            set: async () => {},
        },
    },
    runtime: {
        getURL: () => 'chrome-extension://mock/',
        sendMessage: async () => {},
    },
};
mock.module('wxt/browser', () => ({
    browser: browserMock,
}));

// Import subject under test AFTER mocking
import { runPlatform } from './platform-runner';

describe('Platform Runner', () => {
    beforeEach(() => {
        // Reset DOM
        document.body.innerHTML = '';
        currentAdapterMock = mockAdapter;

        // Mock window.location properties
        const locationMock = {
            href: 'https://test.com/c/123',
            origin: 'https://test.com',
        };

        delete (window as any).location;
        (window as any).location = locationMock;
        (global as any).alert = () => {};
    });

    it('should inject button when valid adapter and ID found', async () => {
        runPlatform();

        // Wait for async injection logic
        await new Promise((resolve) => setTimeout(resolve, 100));

        const saveBtn = document.getElementById('blackiya-save-btn');
        const copyBtn = document.getElementById('blackiya-copy-btn');
        expect(saveBtn).not.toBeNull();
        expect(copyBtn).not.toBeNull();
        expect(saveBtn?.textContent).toContain('Save JSON');
    });

    it('should NOT inject button if no adapter matches', async () => {
        currentAdapterMock = null;
        runPlatform();

        await new Promise((resolve) => setTimeout(resolve, 100));

        const saveBtn = document.getElementById('blackiya-save-btn');
        expect(saveBtn).toBeNull();
    });

    it('should respond with cached conversation JSON for window bridge request', async () => {
        runPlatform();

        const data = { conversation_id: '123', title: 'Test', mapping: {} };
        currentAdapterMock.parseInterceptedData = () => data;
        const message = new (window as any).MessageEvent('message', {
            data: { type: 'LLM_CAPTURE_DATA_INTERCEPTED', url: 'https://test.com/api', data: '{}' },
            origin: window.location.origin,
            source: window,
        });
        window.dispatchEvent(message);

        const responsePromise = new Promise<any>((resolve) => {
            const handler = (event: MessageEvent) => {
                if (event.data?.type !== 'BLACKIYA_GET_JSON_RESPONSE') {
                    return;
                }
                window.removeEventListener('message', handler);
                resolve(event.data);
            };
            window.addEventListener('message', handler);
        });

        window.postMessage(
            { type: 'BLACKIYA_GET_JSON_REQUEST', requestId: 'request-1' },
            window.location.origin,
        );

        const responsePayload = await responsePromise;
        expect(responsePayload).toEqual({
            type: 'BLACKIYA_GET_JSON_RESPONSE',
            requestId: 'request-1',
            success: true,
            data,
        });
    });
});
