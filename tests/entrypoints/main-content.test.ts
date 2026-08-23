import { describe, expect, it, mock } from 'bun:test';

mock.module('wxt/browser', () => ({
    browser: {
        runtime: {
            onMessage: { addListener: () => {}, removeListener: () => {} },
            sendMessage: async () => {},
        },
    },
}));

import {
    createConversationRouteControlsController,
    resolveSupportedConversationRoute,
} from '../../entrypoints/main.content';

const X_CONVERSATION_ID = '2091428436845772921';

type RouteListener = () => void;

const createRouteWindow = (initialHref: string) => {
    let href = initialHref;
    const listeners = new Map<string, Set<RouteListener>>();
    let nextTimerId = 1;
    const timers = new Map<number, () => void>();

    const resolveHref = (url: string | URL | null | undefined) =>
        url == null ? href : new URL(String(url), href).toString();

    const routeWindow = {
        location: {
            get href() {
                return href;
            },
        },
        history: {
            pushState(_data: unknown, _unused: string, url?: string | URL | null) {
                href = resolveHref(url);
            },
            replaceState(_data: unknown, _unused: string, url?: string | URL | null) {
                href = resolveHref(url);
            },
        },
        addEventListener(type: string, listener: RouteListener) {
            const typeListeners = listeners.get(type) ?? new Set<RouteListener>();
            typeListeners.add(listener);
            listeners.set(type, typeListeners);
        },
        removeEventListener(type: string, listener: RouteListener) {
            listeners.get(type)?.delete(listener);
        },
        setInterval(callback: () => void) {
            const id = nextTimerId++;
            timers.set(id, callback);
            return id;
        },
        clearInterval(id: number) {
            timers.delete(id);
        },
    };

    return {
        routeWindow,
        setHref(nextHref: string) {
            href = nextHref;
        },
        dispatch(type: string) {
            for (const listener of listeners.get(type) ?? []) {
                listener();
            }
        },
        tick() {
            for (const callback of timers.values()) {
                callback();
            }
        },
    };
};

describe('single-export conversation route controls', () => {
    it('should recognize only supported routes with valid conversation ids', () => {
        expect(resolveSupportedConversationRoute('https://x.com/home')).toBeNull();
        expect(resolveSupportedConversationRoute('https://x.com/settings/account')).toBeNull();
        expect(resolveSupportedConversationRoute('https://x.com/i/grok')).toBeNull();
        expect(
            resolveSupportedConversationRoute(`https://x.com/i/grok?conversation=${X_CONVERSATION_ID}`),
        ).toMatchObject({ platform: 'Grok', conversationId: X_CONVERSATION_ID });
        expect(resolveSupportedConversationRoute('https://claude.ai/')).toBeNull();
        expect(resolveSupportedConversationRoute('https://claude.ai/settings/profile')).toBeNull();
    });

    it('should mount and unmount on pushState, replaceState, and popstate route changes', () => {
        const testWindow = createRouteWindow('https://x.com/home');
        const controls = {
            mount: mock(() => ({}) as HTMLElement),
            destroy: mock(() => {}),
        };
        const controller = createConversationRouteControlsController({
            window: testWindow.routeWindow,
            controls,
            pollIntervalMs: 10_000,
        });

        controller.start();
        expect(controls.mount).toHaveBeenCalledTimes(0);

        testWindow.routeWindow.history.pushState({}, '', `/i/grok?conversation=${X_CONVERSATION_ID}`);
        expect(controls.mount).toHaveBeenCalledTimes(1);

        testWindow.routeWindow.history.replaceState({}, '', '/settings/account');
        expect(controls.destroy).toHaveBeenCalledTimes(2);

        testWindow.setHref(`https://x.com/i/grok?conversation=${X_CONVERSATION_ID}`);
        testWindow.dispatch('popstate');
        expect(controls.mount).toHaveBeenCalledTimes(2);

        testWindow.setHref('https://x.com/home');
        testWindow.tick();
        expect(controls.destroy).toHaveBeenCalledTimes(3);

        controller.stop();
    });
});
