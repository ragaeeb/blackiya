/**
 * Navigation Manager
 *
 * Handles monitoring for page navigation and DOM changes.
 * Uses MutationObserver and History API hooks to detect when the user moves
 * between conversations or when the page structure updates (SPA navigation).
 */
import { logger } from '@/utils/logger';

export class NavigationManager {
    private observer: MutationObserver | null = null;
    private navigationTimeout: number | undefined;
    private onNavigationChange: () => void;

    constructor(onNavigationChange: () => void) {
        this.onNavigationChange = onNavigationChange;
    }

    public start(): void {
        this.setupMutationObserver();
        this.setupHistoryListeners();
        logger.info('NavigationManager started');
    }

    public stop(): void {
        if (this.observer) {
            this.observer.disconnect();
            this.observer = null;
        }

        if (this.navigationTimeout) {
            clearTimeout(this.navigationTimeout);
            this.navigationTimeout = undefined;
        }

        window.removeEventListener('popstate', this.onNavigationChange);

        // Note: we can't easily remove the patched pushState/replaceState hooks
        // safely without potentially breaking other scripts, so we leave them be.
        // This is a trade-off for SPA monitoring.
    }

    private setupMutationObserver(): void {
        this.observer = new MutationObserver(() => {
            if (this.navigationTimeout) {
                clearTimeout(this.navigationTimeout);
            }

            // Debounce navigation checks
            this.navigationTimeout = window.setTimeout(() => {
                logger.debug('[NavigationManager] URL change detected:', window.location.href);
                this.onNavigationChange();
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

    private setupHistoryListeners(): void {
        window.addEventListener('popstate', this.onNavigationChange);

        // Monkey-patch history to detect pushState/replaceState
        // This is standard for SPA extensions to catch soft navigations
        const originalPushState = history.pushState;
        history.pushState = (...args) => {
            originalPushState.apply(history, args);
            this.onNavigationChange();
        };

        const originalReplaceState = history.replaceState;
        history.replaceState = (...args) => {
            originalReplaceState.apply(history, args);
            this.onNavigationChange();
        };
    }
}
