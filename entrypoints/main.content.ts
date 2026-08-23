import { browser } from 'wxt/browser';
import type { ExportControls } from '@/features/export-controls/contract';
import { createExportControls } from '@/features/export-controls/export-controls';
import { createMainWorldCommandBridge } from '@/features/runtime/main-world-command-request';
import { createV3ContentRuntime } from '@/features/runtime/v3-content-runtime';
import { SUPPORTED_PLATFORM_URLS } from '@/platforms/constants';
import { getPlatformAdapter } from '@/platforms/factory';
import { MESSAGE_TYPES } from '@/utils/protocol/constants';
import { generateSessionToken, getSessionToken, setSessionToken, stampToken } from '@/utils/protocol/session-token';

const defineScript = typeof defineContentScript !== 'undefined' ? defineContentScript : (config: any) => config;

type RuntimeListener = (message: unknown) => Promise<unknown>;
type RuntimeWrapper = (message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => boolean;

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
    window.postMessage(stampToken({ type: MESSAGE_TYPES.SESSION_INIT, token }), window.location.origin);
    return token;
};

export const resolveSupportedConversationRoute = (url: string) => {
    const adapter = getPlatformAdapter(url);
    if (!adapter) {
        return null;
    }
    const conversationId = adapter.extractConversationId(url);
    return conversationId ? { platform: adapter.name, conversationId } : null;
};

type ConversationRouteWindow = {
    location: { readonly href: string };
    history: {
        pushState: (data: unknown, unused: string, url?: string | URL | null) => void;
        replaceState: (data: unknown, unused: string, url?: string | URL | null) => void;
    };
    addEventListener: (type: string, listener: () => void) => void;
    removeEventListener: (type: string, listener: () => void) => void;
    setInterval: (callback: () => void, delayMs: number) => number;
    clearInterval: (timer: number) => void;
};

type ConversationRouteControlsControllerOptions = {
    window: ConversationRouteWindow;
    controls: Pick<ExportControls, 'mount' | 'destroy'>;
    pollIntervalMs?: number;
    resolveRoute?: typeof resolveSupportedConversationRoute;
};

const ROUTE_POLL_INTERVAL_MS = 250;

export const createConversationRouteControlsController = ({
    window: routeWindow,
    controls,
    pollIntervalMs = ROUTE_POLL_INTERVAL_MS,
    resolveRoute = resolveSupportedConversationRoute,
}: ConversationRouteControlsControllerOptions) => {
    let started = false;
    let lastHref: string | null = null;
    let pollTimer: number | null = null;
    const originalPushState = routeWindow.history.pushState;
    const originalReplaceState = routeWindow.history.replaceState;

    const syncControls = () => {
        const href = routeWindow.location.href;
        if (href === lastHref) {
            return;
        }
        lastHref = href;
        if (resolveRoute(href)) {
            controls.mount();
        } else {
            controls.destroy();
        }
    };

    const pushState: typeof originalPushState = (data, unused, url) => {
        originalPushState.call(routeWindow.history, data, unused, url);
        syncControls();
    };
    const replaceState: typeof originalReplaceState = (data, unused, url) => {
        originalReplaceState.call(routeWindow.history, data, unused, url);
        syncControls();
    };

    const start = () => {
        if (started) {
            return;
        }
        started = true;
        routeWindow.history.pushState = pushState;
        routeWindow.history.replaceState = replaceState;
        routeWindow.addEventListener('popstate', syncControls);
        pollTimer = routeWindow.setInterval(syncControls, pollIntervalMs);
        syncControls();
    };

    const stop = () => {
        if (!started) {
            return;
        }
        started = false;
        routeWindow.removeEventListener('popstate', syncControls);
        if (routeWindow.history.pushState === pushState) {
            routeWindow.history.pushState = originalPushState;
        }
        if (routeWindow.history.replaceState === replaceState) {
            routeWindow.history.replaceState = originalReplaceState;
        }
        if (pollTimer !== null) {
            routeWindow.clearInterval(pollTimer);
            pollTimer = null;
        }
        controls.destroy();
    };

    return { start, stop, sync: syncControls };
};

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
                const route = resolveSupportedConversationRoute(window.location.href);
                if (!route) {
                    throw new Error('No supported conversation found for this tab.');
                }
                return route;
            },
            onExport: async () => {
                await mainWorldBridge.exportSingle();
            },
        });
        const routeControls = createConversationRouteControlsController({
            window: window as unknown as ConversationRouteWindow,
            controls,
        });
        routeControls.start();
        window.addEventListener('pagehide', routeControls.stop, { once: true });

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
