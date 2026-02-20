/**
 * Navigation Manager
 *
 * Handles monitoring for page navigation and DOM changes.
 * Uses MutationObserver and History API hooks to detect when the user moves
 * between conversations or when the page structure updates (SPA navigation).
 */
import { logger } from '@/utils/logger';

type HistoryHook = {
    originalPushState: History['pushState'];
    originalReplaceState: History['replaceState'];
    listeners: Set<() => void>;
};

const HISTORY_HOOK_KEY = '__BLACKIYA_NAV_HISTORY_HOOK__';

export class NavigationManager {
    private observer: MutationObserver | null = null;
    private navigationTimeout: number | undefined;
    private onNavigationChange: () => void;
    private lastKnownUrl = '';
    private readonly handlePotentialNavigation = () => {
        const nextUrl = window.location.href;
        if (nextUrl === this.lastKnownUrl) {
            return;
        }
        this.lastKnownUrl = nextUrl;
        logger.debug('[NavigationManager] URL change detected:', nextUrl);
        this.onNavigationChange();
    };

    constructor(onNavigationChange: () => void) {
        this.onNavigationChange = onNavigationChange;
    }

    public start() {
        this.lastKnownUrl = window.location.href;
        this.setupMutationObserver();
        this.setupHistoryListeners();
        logger.info('NavigationManager started');
    }

    public stop() {
        if (this.observer) {
            this.observer.disconnect();
            this.observer = null;
        }

        if (this.navigationTimeout) {
            clearTimeout(this.navigationTimeout);
            this.navigationTimeout = undefined;
        }

        window.removeEventListener('popstate', this.handlePotentialNavigation);
        this.unregisterHistoryListener();
    }

    private setupMutationObserver() {
        this.observer = new MutationObserver(() => {
            if (this.navigationTimeout) {
                clearTimeout(this.navigationTimeout);
            }

            // Debounce navigation checks
            this.navigationTimeout = window.setTimeout(() => {
                this.handlePotentialNavigation();
            }, 300); // 300ms debounce
        });

        // Optimization: In the future, we can target specific containers per platform.
        // For now, observing body is necessary for generic SPA support but verified
        // Performance impact is acceptable with debounce.
        this.observer.observe(document.body, {
            childList: true,
            subtree: true,
        });
    }

    private setupHistoryListeners() {
        window.addEventListener('popstate', this.handlePotentialNavigation);
        this.registerHistoryListener();
    }

    private registerHistoryListener() {
        const registry = window as Window & { [HISTORY_HOOK_KEY]?: HistoryHook };
        let hook = registry[HISTORY_HOOK_KEY];
        if (!hook) {
            const originalPushState = history.pushState;
            const originalReplaceState = history.replaceState;
            const listeners = new Set<() => void>();

            history.pushState = ((...args: Parameters<History['pushState']>) => {
                originalPushState.apply(history, args);
                for (const listener of listeners) {
                    listener();
                }
            }) as History['pushState'];

            history.replaceState = ((...args: Parameters<History['replaceState']>) => {
                originalReplaceState.apply(history, args);
                for (const listener of listeners) {
                    listener();
                }
            }) as History['replaceState'];

            hook = {
                originalPushState,
                originalReplaceState,
                listeners,
            };
            registry[HISTORY_HOOK_KEY] = hook;
        }

        hook.listeners.add(this.handlePotentialNavigation);
    }

    private unregisterHistoryListener() {
        const registry = window as Window & { [HISTORY_HOOK_KEY]?: HistoryHook };
        const hook = registry[HISTORY_HOOK_KEY];
        if (!hook) {
            return;
        }

        hook.listeners.delete(this.handlePotentialNavigation);

        if (hook.listeners.size > 0) {
            return;
        }

        history.pushState = hook.originalPushState;
        history.replaceState = hook.originalReplaceState;
        delete registry[HISTORY_HOOK_KEY];
    }
}
