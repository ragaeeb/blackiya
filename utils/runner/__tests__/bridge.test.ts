/**
 * Tests: Window bridge – BLACKIYA_GET_JSON_REQUEST / RESPONSE.
 *
 * Covers:
 *  - Returns cached canonical conversation JSON on a valid bridge request
 *  - Returns common-format JSON when format:'common' is requested
 *  - Gracefully rejects when no conversation data has been captured
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { Window } from 'happy-dom';

const window = new Window();
const document = window.document;
(global as any).window = window;
(global as any).document = document;
(global as any).history = window.history;
(global as any).HTMLElement = window.HTMLElement;
(global as any).HTMLButtonElement = window.HTMLButtonElement;
(global as any).MutationObserver = window.MutationObserver;

import {
    buildBrowserMock,
    buildLoggerMock,
    createLoggerCalls,
    createMockAdapter,
    makePostStampedMessage,
} from './helpers';

let currentAdapterMock: any = createMockAdapter(document);
const browserMockState = {
    storageData: {} as Record<string, unknown>,
    sendMessage: async (_: unknown) => undefined as unknown,
};

mock.module('@/platforms/factory', () => ({
    getPlatformAdapter: () => currentAdapterMock,
    getPlatformAdapterByApiUrl: () => currentAdapterMock,
}));
mock.module('@/utils/download', () => ({ downloadAsJSON: () => {} }));
mock.module('@/utils/logger', () => buildLoggerMock(createLoggerCalls()));
mock.module('wxt/browser', () => buildBrowserMock(browserMockState));

import { getSessionToken } from '@/utils/protocol/session-token';
import { runPlatform } from '@/utils/runner/platform-runtime';

const postStampedMessage = makePostStampedMessage(window as any, getSessionToken);

const waitForReadyStatus = async () =>
    await new Promise<any>((resolve, reject) => {
        const timeout = setTimeout(() => {
            window.removeEventListener('message', handler as any);
            reject(new Error('Timed out waiting for ready status'));
        }, 2000);
        const handler = (event: any) => {
            if (event?.data?.type !== 'BLACKIYA_PUBLIC_STATUS') {
                return;
            }
            const status = event.data?.status;
            if (!status?.canGetJSON || !status?.canGetCommonJSON) {
                return;
            }
            clearTimeout(timeout);
            window.removeEventListener('message', handler as any);
            resolve(status);
        };
        window.addEventListener('message', handler as any);
    });

// Shared fixture

const twoTurnConversation = {
    title: 'Test',
    create_time: 1_700_000_000,
    update_time: 1_700_000_100,
    conversation_id: '123',
    current_node: 'node-2',
    mapping: {
        root: { id: 'root', message: null, parent: null, children: ['node-1'] },
        'node-1': {
            id: 'node-1',
            message: {
                id: 'node-1',
                author: { role: 'user', name: 'User', metadata: {} },
                create_time: 1_700_000_010,
                update_time: 1_700_000_010,
                content: { content_type: 'text', parts: ['Hello'] },
                status: 'finished_successfully',
                end_turn: true,
                weight: 1,
                metadata: {},
                recipient: 'all',
                channel: null,
            },
            parent: 'root',
            children: ['node-2'],
        },
        'node-2': {
            id: 'node-2',
            message: {
                id: 'node-2',
                author: { role: 'assistant', name: 'Assistant', metadata: {} },
                create_time: 1_700_000_020,
                update_time: 1_700_000_020,
                content: { content_type: 'text', parts: ['Hi'] },
                status: 'finished_successfully',
                end_turn: true,
                weight: 1,
                metadata: {},
                recipient: 'all',
                channel: null,
            },
            parent: 'node-1',
            children: [],
        },
    },
    moderation_results: [],
    plugin_ids: null,
    gizmo_id: null,
    gizmo_type: null,
    is_archived: false,
    default_model_slug: 'test-model',
    safe_urls: [],
    blocked_urls: [],
};

/** Ingest the fixture twice so SFE stabilises and the bridge has data to serve. */
const ingestAndStabilise = async () => {
    const interceptMsg = new (window as any).MessageEvent('message', {
        data: {
            type: 'LLM_CAPTURE_DATA_INTERCEPTED',
            url: 'https://test.com/api',
            data: '{}',
            __blackiyaToken: getSessionToken(),
        },
        origin: window.location.origin,
        source: window,
    });
    window.dispatchEvent(interceptMsg);
    await new Promise((r) => setTimeout(r, 950));
    window.dispatchEvent(interceptMsg);
    await new Promise((r) => setTimeout(r, 40));
};

describe('Platform Runner – window bridge', () => {
    beforeEach(() => {
        window.dispatchEvent(new (window as any).Event('beforeunload'));
        document.body.innerHTML = '';
        currentAdapterMock = createMockAdapter(document);
        browserMockState.storageData = {};
        browserMockState.sendMessage = async () => undefined;
        delete (window as any).location;
        (window as any).location = { href: 'https://test.com/c/123', origin: 'https://test.com' };
        (global as any).alert = () => {};
        (global as any).confirm = () => true;
        window.localStorage.clear();
        (globalThis as any).__BLACKIYA_CAPTURE_QUEUE__ = [];
        (globalThis as any).__BLACKIYA_LOG_QUEUE__ = [];
    });

    afterEach(() => {
        window.dispatchEvent(new (window as any).Event('beforeunload'));
    });

    it('should respond with cached conversation JSON for window bridge request', async () => {
        currentAdapterMock.parseInterceptedData = () => twoTurnConversation;
        runPlatform();
        await ingestAndStabilise();

        const responsePromise = new Promise<any>((resolve) => {
            const handler = (event: any) => {
                if (event?.data?.type !== 'BLACKIYA_GET_JSON_RESPONSE') {
                    return;
                }
                window.removeEventListener('message', handler as any);
                resolve(event.data);
            };
            window.addEventListener('message', handler as any);
        });

        postStampedMessage({ type: 'BLACKIYA_GET_JSON_REQUEST', requestId: 'req-1' }, window.location.origin);

        const response = await responsePromise;
        expect(response).toMatchObject({
            type: 'BLACKIYA_GET_JSON_RESPONSE',
            requestId: 'req-1',
            success: true,
            data: twoTurnConversation,
        });
    });

    it('should respond with common-format JSON when format:"common" is requested', async () => {
        currentAdapterMock.parseInterceptedData = () => twoTurnConversation;
        runPlatform();
        await ingestAndStabilise();

        const responsePromise = new Promise<any>((resolve) => {
            const handler = (event: any) => {
                if (event?.data?.type !== 'BLACKIYA_GET_JSON_RESPONSE') {
                    return;
                }
                window.removeEventListener('message', handler as any);
                resolve(event.data);
            };
            window.addEventListener('message', handler as any);
        });

        postStampedMessage(
            { type: 'BLACKIYA_GET_JSON_REQUEST', requestId: 'req-2', format: 'common' },
            window.location.origin,
        );

        const response = await responsePromise;
        expect(response.type).toBe('BLACKIYA_GET_JSON_RESPONSE');
        expect(response.requestId).toBe('req-2');
        expect(response.success).toBeTrue();
        expect(response.data.format).toBe('common');
        expect(response.data.llm).toBe('TestPlatform');
    });

    it('should allow getJSON when ready event is emitted', async () => {
        currentAdapterMock.parseInterceptedData = () => twoTurnConversation;
        runPlatform();
        const readyPromise = waitForReadyStatus();
        await ingestAndStabilise();
        await readyPromise;

        const responsePromise = new Promise<any>((resolve) => {
            const handler = (event: any) => {
                if (event?.data?.type !== 'BLACKIYA_GET_JSON_RESPONSE') {
                    return;
                }
                window.removeEventListener('message', handler as any);
                resolve(event.data);
            };
            window.addEventListener('message', handler as any);
        });

        postStampedMessage(
            { type: 'BLACKIYA_GET_JSON_REQUEST', requestId: 'req-ready-original' },
            window.location.origin,
        );

        const response = await responsePromise;
        expect(response.success).toBeTrue();
        expect(response.data).toEqual(twoTurnConversation);
    });

    it('should allow getCommonJSON when ready event is emitted', async () => {
        currentAdapterMock.parseInterceptedData = () => twoTurnConversation;
        runPlatform();
        const readyPromise = waitForReadyStatus();
        await ingestAndStabilise();
        await readyPromise;

        const responsePromise = new Promise<any>((resolve) => {
            const handler = (event: any) => {
                if (event?.data?.type !== 'BLACKIYA_GET_JSON_RESPONSE') {
                    return;
                }
                window.removeEventListener('message', handler as any);
                resolve(event.data);
            };
            window.addEventListener('message', handler as any);
        });

        postStampedMessage(
            { type: 'BLACKIYA_GET_JSON_REQUEST', requestId: 'req-ready-common', format: 'common' },
            window.location.origin,
        );

        const response = await responsePromise;
        expect(response.success).toBeTrue();
        expect(response.data.format).toBe('common');
        expect(response.data.llm).toBe('TestPlatform');
    });

    it('should gracefully reject bridge request when no conversation data has been captured', async () => {
        runPlatform();

        // Ingest something the adapter cannot parse → no cached data
        const interceptMsg = new (window as any).MessageEvent('message', {
            data: {
                type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                url: 'https://test.com/api',
                data: '{}',
                __blackiyaToken: getSessionToken(),
            },
            origin: window.location.origin,
            source: window,
        });
        window.dispatchEvent(interceptMsg);

        const responsePromise = new Promise<any>((resolve) => {
            const handler = (event: any) => {
                if (event?.data?.type !== 'BLACKIYA_GET_JSON_RESPONSE') {
                    return;
                }
                window.removeEventListener('message', handler as any);
                resolve(event.data);
            };
            window.addEventListener('message', handler as any);
        });

        postStampedMessage({ type: 'BLACKIYA_GET_JSON_REQUEST', requestId: 'req-incomplete' }, window.location.origin);

        const response = await responsePromise;
        expect(response).toMatchObject({
            type: 'BLACKIYA_GET_JSON_RESPONSE',
            requestId: 'req-incomplete',
            success: false,
            error: 'NO_CONVERSATION_DATA',
        });
        expect(response.data).toBeUndefined();
        expect(typeof response.__blackiyaToken).toBe('string');
    });
});
