import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Window } from 'happy-dom';
import { getSessionToken, setSessionToken, stampToken } from '@/utils/protocol/session-token';
import { requestXGrokGraphqlContextFromMainWorld } from '@/utils/runner/x-grok-graphql-request';
import {
    X_GROK_GRAPHQL_CONTEXT_REQUEST_MESSAGE,
    X_GROK_GRAPHQL_CONTEXT_RESPONSE_MESSAGE,
    type XGrokGraphqlContextRequestMessage,
} from '@/utils/x-grok-graphql-bridge';

describe('x-grok-graphql-request', () => {
    let windowInstance: Window;
    let originalWindow: unknown;

    beforeEach(() => {
        windowInstance = new Window();
        originalWindow = (globalThis as any).window;
        (globalThis as any).window = windowInstance;
        setSessionToken('bk:test-x-grok-context-request');
    });

    afterEach(() => {
        (globalThis as any).window = originalWindow;
    });

    it('should request and resolve x-grok graphql context from main world response', async () => {
        windowInstance.addEventListener('message', ((event: MessageEvent) => {
            const request = event.data as XGrokGraphqlContextRequestMessage;
            if (request?.type !== X_GROK_GRAPHQL_CONTEXT_REQUEST_MESSAGE) {
                return;
            }
            windowInstance.postMessage(
                stampToken({
                    type: X_GROK_GRAPHQL_CONTEXT_RESPONSE_MESSAGE,
                    requestId: request.requestId,
                    context: {
                        queryId: 'n2bhau0B2DSY6R_bLolgSg',
                        features: '{"responsive_web_grok_annotations_enabled":true}',
                        updatedAt: Date.now(),
                    },
                }),
                windowInstance.location.origin,
            );
        }) as any);

        const context = await requestXGrokGraphqlContextFromMainWorld(250);
        expect(context?.queryId).toBe('n2bhau0B2DSY6R_bLolgSg');
        expect(context?.features).toBe('{"responsive_web_grok_annotations_enabled":true}');
    });

    it('should return undefined on timeout', async () => {
        const context = await requestXGrokGraphqlContextFromMainWorld(25);
        expect(context).toBeUndefined();
    });

    it('should ignore mismatched token responses', async () => {
        windowInstance.addEventListener('message', ((event: MessageEvent) => {
            const request = event.data as XGrokGraphqlContextRequestMessage;
            if (request?.type !== X_GROK_GRAPHQL_CONTEXT_REQUEST_MESSAGE) {
                return;
            }
            windowInstance.postMessage(
                {
                    type: X_GROK_GRAPHQL_CONTEXT_RESPONSE_MESSAGE,
                    requestId: request.requestId,
                    context: { queryId: 'wrong', updatedAt: Date.now() },
                    __blackiyaToken: 'bk:wrong-token',
                },
                windowInstance.location.origin,
            );
        }) as any);

        const context = await requestXGrokGraphqlContextFromMainWorld(50);
        expect(context).toBeUndefined();
        expect(getSessionToken()).toBe('bk:test-x-grok-context-request');
    });
});
