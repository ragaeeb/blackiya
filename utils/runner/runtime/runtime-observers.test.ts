import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { registerButtonHealthCheck, registerWindowBridge } from '@/utils/runner/runtime/runtime-observers';

describe('runtime-observers', () => {
    describe('registerWindowBridge', () => {
        let originalWindow: any;
        beforeEach(() => {
            originalWindow = (globalThis as any).window;
            (globalThis as any).window = {
                addEventListener: mock(() => {}),
                removeEventListener: mock(() => {}),
                location: { origin: 'http://test' },
            };
            (window as any).source = window;
        });
        afterEach(() => {
            (globalThis as any).window = originalWindow;
        });

        it('should register and unregister event listener', () => {
            const untrack = registerWindowBridge({
                messageHandlers: [],
                invalidSessionTokenLogAtRef: { value: 0 },
            });

            expect(window.addEventListener).toHaveBeenCalledWith('message', expect.any(Function));
            untrack();
            expect(window.removeEventListener).toHaveBeenCalledWith('message', expect.any(Function));
        });
    });

    describe('registerButtonHealthCheck', () => {
        let originalWindow: any;
        let originalDocument: any;
        let originalMutationObserver: any;
        let originalClearInterval: any;
        let observerInstances: Array<{ callback: () => void; disconnect: ReturnType<typeof mock> }>;

        beforeEach(() => {
            originalWindow = (globalThis as any).window;
            originalDocument = (globalThis as any).document;
            originalMutationObserver = (globalThis as any).MutationObserver;
            originalClearInterval = globalThis.clearInterval;
            observerInstances = [];

            (globalThis as any).window = {
                setInterval: mock(() => 123) as any,
                clearInterval: mock(() => {}) as any,
            };
            (globalThis as any).document = { body: {} };
            (globalThis as any).MutationObserver = class {
                private readonly callback: () => void;
                public readonly disconnect = mock(() => {});

                constructor(callback: () => void) {
                    this.callback = callback;
                    observerInstances.push({ callback, disconnect: this.disconnect });
                }

                observe() {}
            };
            globalThis.clearInterval = mock(() => {}) as any;
        });

        afterEach(() => {
            (globalThis as any).window = originalWindow;
            (globalThis as any).document = originalDocument;
            (globalThis as any).MutationObserver = originalMutationObserver;
            globalThis.clearInterval = originalClearInterval;
        });

        it('should poll health and inject or refresh', () => {
            const deps = {
                getAdapter: mock(() => ({ name: 'ChatGPT' }) as any),
                extractConversationIdFromLocation: mock(() => 'conv-1'),
                buttonManagerExists: mock(() => false),
                injectSaveButton: mock(() => {}),
                refreshButtonState: mock(() => {}),
            };

            const untrack = registerButtonHealthCheck(deps);

            // Invoke the callback that setInterval was called with
            const cb = ((globalThis as any).window.setInterval as ReturnType<typeof mock>).mock.calls[0]![0];

            // First time: button does not exist, injects it
            cb();
            expect(deps.injectSaveButton).toHaveBeenCalled();
            expect(deps.refreshButtonState).not.toHaveBeenCalled();

            // Make button exist
            deps.buttonManagerExists.mockImplementation(() => true);
            cb();
            expect(deps.refreshButtonState).toHaveBeenCalledWith('conv-1');

            untrack();
            expect(globalThis.clearInterval).toHaveBeenCalledWith(123);
        });

        it('should recover controls immediately after a download-triggered DOM replacement', () => {
            const deps = {
                getAdapter: mock(() => ({ name: 'ChatGPT' }) as any),
                extractConversationIdFromLocation: mock(() => 'conv-1'),
                buttonManagerExists: mock(() => false),
                injectSaveButton: mock(() => {}),
                refreshButtonState: mock(() => {}),
            };

            const untrack = registerButtonHealthCheck(deps);

            expect(observerInstances).toHaveLength(1);
            observerInstances[0]!.callback();
            expect(deps.injectSaveButton).toHaveBeenCalledTimes(1);

            untrack();
            expect(observerInstances[0]!.disconnect).toHaveBeenCalledTimes(1);
        });
    });
});
