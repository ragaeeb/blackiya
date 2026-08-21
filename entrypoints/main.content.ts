import { browser } from 'wxt/browser';
import { createV3ContentRuntime } from '@/features/runtime/v3-content-runtime';
import { createMainWorldCommandBridge } from '@/features/runtime/main-world-command-request';
import { createExportControls } from '@/features/export-controls/export-controls';
import { getPlatformAdapter } from '@/platforms/factory';
import { SUPPORTED_PLATFORM_URLS } from '@/platforms/constants';
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
        const mainWorldBridge = createMainWorldCommandBridge({
            window: window as any,
            token: sessionToken,
        });

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
            onExport: async () => {
                await mainWorldBridge.exportSingle();
            },
        });
        controls.mount();

        createV3ContentRuntime({
            host: createRuntimeHost(),
            window: window as any,
            sessionToken,
            mainWorldBridge,
            onBulkProgress: (message) => {
                void browser.runtime.sendMessage(message);
            },
        });

    },
});
