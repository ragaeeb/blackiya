import { browser } from 'wxt/browser';
import { createV3ContentRuntime } from '@/features/runtime/v3-content-runtime';
import { requestGeminiBatchexecuteContextFromMainWorld } from '@/features/runtime/gemini-context-request';
import { requestPlatformHeadersFromMainWorld } from '@/features/runtime/platform-header-request';
import { createExportControls } from '@/features/export-controls/export-controls';
import { performSingleExport } from '@/features/single-export/single-export-service';
import { runBulkExport } from '@/features/bulk-export/orchestrator';
import { getPlatformAdapter } from '@/platforms/factory';
import { SUPPORTED_PLATFORM_URLS } from '@/platforms/constants';
import { downloadStringAsJsonFile } from '@/utils/dom-download';
import { generateSessionToken, getSessionToken, setSessionToken, stampToken } from '@/utils/protocol/session-token';
import { MESSAGE_TYPES } from '@/utils/protocol/constants';

const defineScript = typeof defineContentScript !== 'undefined' ? defineContentScript : (config: any) => config;

type RuntimeListener = (message: unknown) => Promise<unknown>;
type RuntimeWrapper = (
    message: unknown,
    sender: unknown,
    sendResponse: (response: unknown) => void,
) => boolean;

const createRuntimeHost = () => {
    const wrappers = new Map<RuntimeListener, RuntimeWrapper>();
    return {
        onMessage: {
            addListener(listener: RuntimeListener) {
                const wrapper = (message: unknown, _sender: unknown, sendResponse: (response: unknown) => void) => {
                    void listener(message).then(sendResponse);
                    return true;
                };
                wrappers.set(listener, wrapper);
                browser.runtime.onMessage.addListener(wrapper as any);
            },
            removeListener(listener: (message: unknown) => Promise<unknown>) {
                const wrapper = wrappers.get(listener);
                if (wrapper) {
                    browser.runtime.onMessage.removeListener(wrapper as any);
                    wrappers.delete(listener);
                }
            },
        },
    };
};

const ensureSessionToken = (): string => {
    const existing = getSessionToken();
    if (existing) {
        return existing;
    }
    const token = generateSessionToken();
    setSessionToken(token);
    window.postMessage(
        stampToken({ type: MESSAGE_TYPES.SESSION_INIT, token }),
        window.location.origin,
    );
    return token;
};

const resolveAdapterAtClick = () => getPlatformAdapter(window.location.href);

export default defineScript({
    matches: [...SUPPORTED_PLATFORM_URLS],
    runAt: 'document_idle',
    main() {
        const sessionToken = ensureSessionToken();

        const getHeaders = (platformName: string) => requestPlatformHeadersFromMainWorld(platformName);
        const getGeminiContext = () => requestGeminiBatchexecuteContextFromMainWorld();

        const runSingleExportFromPage = async () => {
            const adapter = resolveAdapterAtClick();
            if (!adapter) {
                throw new Error('No supported platform found for this tab.');
            }
            const headers = await getHeaders(adapter.name);
            const geminiContext = adapter.name === 'Gemini' ? await getGeminiContext() : undefined;
            const result = await performSingleExport(undefined, {
                resolveAdapter: () => adapter,
                getPageUrl: () => window.location.href,
                getAuthHeaders: () => headers,
                getGeminiBatchexecuteContext: () => geminiContext,
                downloadJson: downloadStringAsJsonFile,
            });
            if (result.kind === 'failure') {
                throw new Error(formatSingleExportError(result.error));
            }
        };

        const controls = createExportControls({
            resolveActionContext: () => {
                const adapter = resolveAdapterAtClick();
                if (!adapter) {
                    throw new Error('No supported platform found for this tab.');
                }
                return {
                    platform: adapter.name,
                    conversationId: adapter.extractConversationId(window.location.href),
                };
            },
            onExport: runSingleExportFromPage,
        });
        controls.mount();

        createV3ContentRuntime({
            host: createRuntimeHost(),
            window: window as any,
            sessionToken,
            runBulkExport: async (options) => {
                const adapter = resolveAdapterAtClick();
                if (!adapter) {
                    throw new Error('No supported platform found for this tab.');
                }
                const headers = await getHeaders(adapter.name);
                const geminiContext = adapter.name === 'Gemini' ? await getGeminiContext() : undefined;
                return runBulkExport(options, {
                    getAdapter: () => adapter,
                    getAuthHeaders: () => headers,
                    getGeminiBatchexecuteContext: () => geminiContext,
                    onProgress: (message) => {
                        void browser.runtime.sendMessage(message);
                    },
                });
            },
        });

    },
});

const formatSingleExportError = (error: { kind: string; reason?: string; status?: number; timeoutMs?: number }): string => {
    switch (error.kind) {
        case 'not_terminal':
            return `Conversation is not ready to save${error.reason ? ` (${error.reason})` : ''}.`;
        case 'timeout':
            return `Conversation request timed out after ${error.timeoutMs ?? 'the configured'} ms.`;
        case 'missing_auth':
            return 'The page did not provide the authentication context needed to save this conversation.';
        case 'http_failure':
            return `Conversation request failed${error.status ? ` (${error.status})` : ''}.`;
        default:
            return error.reason ? `${error.kind}: ${error.reason}` : error.kind;
    }
};
