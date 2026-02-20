import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { setSessionToken } from '@/utils/protocol/session-token';
import { requestPageSnapshot } from '@/utils/runner/page-snapshot-bridge';

describe('page-snapshot-bridge', () => {
    let mockAddEventListener: ReturnType<typeof mock>;
    let mockRemoveEventListener: ReturnType<typeof mock>;
    let mockPostMessage: ReturnType<typeof mock>;
    let originalWindow: any;
    let originalClearTimeout: any;

    beforeEach(() => {
        originalWindow = (globalThis as any).window;
        originalClearTimeout = globalThis.clearTimeout;

        mockAddEventListener = mock(() => {});
        mockRemoveEventListener = mock(() => {});
        mockPostMessage = mock(() => {});

        (globalThis as any).window = {
            addEventListener: mockAddEventListener,
            removeEventListener: mockRemoveEventListener,
            postMessage: mockPostMessage,
            location: { origin: 'http://test' },
            setTimeout: mock((_fn: any) => {
                return 123;
            }),
        };
        setSessionToken('123');
        globalThis.clearTimeout = mock(() => {});
    });

    afterEach(() => {
        (globalThis as any).window = originalWindow;
        globalThis.clearTimeout = originalClearTimeout;
    });

    it('should post request and wait for valid response', async () => {
        const promise = requestPageSnapshot('conv-1');

        expect(mockPostMessage).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'BLACKIYA_PAGE_SNAPSHOT_REQUEST', conversationId: 'conv-1' }),
            'http://test',
        );

        const listener = mockAddEventListener.mock.calls[0][1];

        const evt = {
            source: globalThis.window,
            origin: 'http://test',
            data: {
                type: 'BLACKIYA_PAGE_SNAPSHOT_RESPONSE',
                requestId: mockPostMessage.mock.calls[0][0].requestId,
                success: true,
                data: 'snap',
                __blackiyaToken: '123',
            },
        };

        listener(evt as unknown as MessageEvent);

        const result = await promise;
        expect(result).toBe('snap');
        expect(mockRemoveEventListener).toHaveBeenCalled();
        expect(globalThis.clearTimeout).toHaveBeenCalledWith(123);
    });

    it('should resolve null if timeout triggers', async () => {
        let timeoutCb: (() => void) | undefined;
        (globalThis.window as any).setTimeout = mock((fn: any) => {
            timeoutCb = fn;
            return 123;
        });

        const promise = requestPageSnapshot('conv-1');

        timeoutCb!();

        const result = await promise;
        expect(result).toBeNull();
        expect(mockRemoveEventListener).toHaveBeenCalled();
    });

    it('should ignore foreign messages and wait for valid one', async () => {
        const promise = requestPageSnapshot('conv-1');

        const listener = mockAddEventListener.mock.calls[0][1];
        const requestId = mockPostMessage.mock.calls[0][0].requestId;

        // Wrong source
        listener({
            source: {},
            origin: 'http://test',
            data: {
                type: 'BLACKIYA_PAGE_SNAPSHOT_RESPONSE',
                requestId,
                success: true,
                data: 'snap',
                __blackiyaToken: '123',
            },
        } as unknown as MessageEvent);

        // Wrong origin
        listener({
            source: globalThis.window,
            origin: 'http://bad',
            data: {
                type: 'BLACKIYA_PAGE_SNAPSHOT_RESPONSE',
                requestId,
                success: true,
                data: 'snap',
                __blackiyaToken: '123',
            },
        } as unknown as MessageEvent);

        // Wrong type
        listener({
            source: globalThis.window,
            origin: 'http://test',
            data: { type: 'OTHER_TYPE', requestId, success: true, data: 'snap', __blackiyaToken: '123' },
        } as unknown as MessageEvent);

        expect(mockRemoveEventListener).not.toHaveBeenCalled();

        // Now send valid one
        listener({
            source: globalThis.window,
            origin: 'http://test',
            data: {
                type: 'BLACKIYA_PAGE_SNAPSHOT_RESPONSE',
                requestId,
                success: true,
                data: 'valid-snap',
                __blackiyaToken: '123',
            },
        } as unknown as MessageEvent);

        const result = await promise;
        expect(result).toBe('valid-snap');
        expect(mockRemoveEventListener).toHaveBeenCalled();
    });
});
