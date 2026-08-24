import { browser } from 'wxt/browser';
import type { ExportActionContext, ExportControls } from '@/features/export-controls/contract';
import { createExportControls } from '@/features/export-controls/export-controls';
import {
    createMainWorldCommandBridge,
    type MainWorldCommandBridge,
} from '@/features/runtime/main-world-command-request';
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

export const createBoundSingleExportHandler = (
    mainWorldBridge: Pick<MainWorldCommandBridge, 'exportSingle'>,
    resolveCurrentRoute: () => ExportActionContext | null = () =>
        resolveSupportedConversationRoute(window.location.href),
) => {
    return async (context: ExportActionContext) => {
        const currentRoute = resolveCurrentRoute();
        if (
            !currentRoute ||
            currentRoute.platform !== context.platform ||
            currentRoute.conversationId !== context.conversationId
        ) {
            throw new Error('Conversation changed before export started.');
        }
        await mainWorldBridge.exportSingle();
    };
};

type ConversationRouteWindow = {
    location: { readonly href: string };
    history: {
        pushState: (data: unknown, unused: string, url?: string | URL | null) => void;
        replaceState: (data: unknown, unused: string, url?: string | URL | null) => void;
    };
    addEventListener: (type: string, listener: (event: { readonly persisted?: boolean }) => void) => void;
    removeEventListener: (type: string, listener: (event: { readonly persisted?: boolean }) => void) => void;
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
    let observingRoutes = false;
    let lifecycleBound = false;
    let lastHref: string | null = null;
    let lastRouteKey: string | null = null;
    let pollTimer: number | null = null;
    const originalPushState = routeWindow.history.pushState;
    const originalReplaceState = routeWindow.history.replaceState;

    const syncControls = () => {
        if (!observingRoutes) {
            return;
        }
        const href = routeWindow.location.href;
        if (href === lastHref) {
            return;
        }
        lastHref = href;
        const route = resolveRoute(href);
        if (route) {
            const routeKey = `${route.platform}\0${route.conversationId}`;
            if (lastRouteKey !== null && lastRouteKey !== routeKey) {
                controls.destroy();
            }
            controls.mount();
            lastRouteKey = routeKey;
        } else {
            controls.destroy();
            lastRouteKey = null;
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

    const startRouteObservation = () => {
        if (observingRoutes) {
            return;
        }
        observingRoutes = true;
        lastHref = null;
        routeWindow.history.pushState = pushState;
        routeWindow.history.replaceState = replaceState;
        routeWindow.addEventListener('popstate', syncControls);
        pollTimer = routeWindow.setInterval(syncControls, pollIntervalMs);
        syncControls();
    };

    const stopRouteObservation = () => {
        if (!observingRoutes) {
            return;
        }
        observingRoutes = false;
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
        lastHref = null;
        lastRouteKey = null;
        controls.destroy();
    };

    const handlePageHide = (event: { readonly persisted?: boolean }) => {
        stopRouteObservation();
        if (!event.persisted) {
            unbindLifecycle();
        }
    };

    const handlePageShow = (event: { readonly persisted?: boolean }) => {
        if (event.persisted && lifecycleBound) {
            startRouteObservation();
        }
    };

    const bindLifecycle = () => {
        if (lifecycleBound) {
            return;
        }
        lifecycleBound = true;
        routeWindow.addEventListener('pagehide', handlePageHide);
        routeWindow.addEventListener('pageshow', handlePageShow);
    };

    const unbindLifecycle = () => {
        if (!lifecycleBound) {
            return;
        }
        lifecycleBound = false;
        routeWindow.removeEventListener('pagehide', handlePageHide);
        routeWindow.removeEventListener('pageshow', handlePageShow);
    };

    const start = () => {
        bindLifecycle();
        startRouteObservation();
    };

    const stop = () => {
        stopRouteObservation();
        unbindLifecycle();
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
            onExport: createBoundSingleExportHandler(mainWorldBridge),
        });
        const routeControls = createConversationRouteControlsController({
            window: window as unknown as ConversationRouteWindow,
            controls,
        });
        routeControls.start();

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
