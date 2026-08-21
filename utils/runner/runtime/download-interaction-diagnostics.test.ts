import { afterEach, describe, expect, it, mock } from 'bun:test';
import { Window } from 'happy-dom';
import {
    registerDownloadInteractionDiagnostics,
    shouldDeferRunnerTeardownAfterDownload,
    type DownloadInteractionDiagnosticsDeps,
} from '@/utils/runner/runtime/download-interaction-diagnostics';

describe('download-interaction-diagnostics', () => {
    let windowInstance: Window;

    afterEach(() => {
        windowInstance?.close();
        delete (globalThis as any).window;
        delete (globalThis as any).document;
    });

    it('should log the download icon and keep follow-up control health checkpoints at debug level', () => {
        windowInstance = new Window();
        const { document } = windowInstance;
        (globalThis as any).window = windowInstance;
        (globalThis as any).document = document;
        document.body.innerHTML = `
            <main>
                <section class="artifact-card">
                    <button aria-label="Download file" data-testid="artifact-download">
                        <svg aria-hidden="true"></svg>
                    </button>
                </section>
            </main>
            <div id="blackiya-button-container" data-blackiya-controls="1">
                <button id="blackiya-save-btn"></button>
            </div>
        `;
        const log = mock((_message: string, _details: Record<string, unknown>) => {});
        const debugLog = mock((_message: string, _details: Record<string, unknown>) => {});
        const checkpoints: Array<() => void> = [];
        const deps: DownloadInteractionDiagnosticsDeps = {
            getAdapterName: () => 'ChatGPT',
            getConversationId: () => 'conversation-1',
            buttonManagerExists: () => true,
            log,
            debugLog,
            schedule: (callback) => {
                checkpoints.push(callback);
                return checkpoints.length;
            },
            cancel: mock(() => {}),
        };

        const untrack = registerDownloadInteractionDiagnostics(deps);
        document.querySelector('svg')?.dispatchEvent(new windowInstance.MouseEvent('click', { bubbles: true }));

        expect(log).toHaveBeenCalledTimes(1);
        expect(log.mock.calls[0]?.[0]).toBe('Download interaction observed');
        expect(log.mock.calls[0]?.[1]).toMatchObject({
            adapter: 'ChatGPT',
            conversationId: 'conversation-1',
            target: {
                tagName: 'BUTTON',
                ariaLabel: 'Download file',
                testId: 'artifact-download',
            },
            health: {
                containerPresent: true,
                containerConnected: true,
                bodyChanged: false,
            },
        });
        expect(checkpoints).toHaveLength(5);
        expect(debugLog).not.toHaveBeenCalled();

        document.querySelector('#blackiya-button-container')?.remove();
        checkpoints[2]!();

        expect(log).toHaveBeenCalledTimes(1);
        expect(debugLog).toHaveBeenCalledTimes(1);
        expect(debugLog.mock.calls[0]?.[0]).toBe('Download interaction DOM state');
        expect(debugLog.mock.calls[0]?.[1]).toMatchObject({
            delayMs: 250,
            health: {
                containerPresent: false,
                containerConnected: false,
                bodyChanged: false,
            },
        });

        untrack();
        expect(deps.cancel).toHaveBeenCalledTimes(4);
    });

    it('should ignore unrelated clicks', () => {
        windowInstance = new Window();
        const { document } = windowInstance;
        (globalThis as any).window = windowInstance;
        (globalThis as any).document = document;
        document.body.innerHTML = '<button aria-label="Copy response">Copy</button>';
        const log = mock(() => {});

        const untrack = registerDownloadInteractionDiagnostics({ log });
        document.querySelector('button')?.dispatchEvent(new windowInstance.MouseEvent('click', { bubbles: true }));

        expect(log).not.toHaveBeenCalled();
        untrack();
    });

    it('should defer runner teardown only during the short post-download grace window', () => {
        expect(shouldDeferRunnerTeardownAfterDownload(null, 10_000)).toBe(false);
        expect(shouldDeferRunnerTeardownAfterDownload(9_000, 10_000)).toBe(true);
        expect(shouldDeferRunnerTeardownAfterDownload(6_000, 10_000)).toBe(false);
        expect(shouldDeferRunnerTeardownAfterDownload(11_000, 10_000)).toBe(false);
    });
});
