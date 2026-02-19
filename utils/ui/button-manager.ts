/**
 * Button Manager Utility
 *
 * Handles creation/styling/state for compact in-page controls.
 */
import { logger } from '@/utils/logger';

export class ButtonManager {
    private readonly controlIds = ['blackiya-lifecycle-badge', 'blackiya-save-btn', 'blackiya-calibrate-btn'];
    private container: HTMLElement | null = null;
    private lifecycleBadge: HTMLElement | null = null;
    private saveStartButton: HTMLButtonElement | null = null;
    private calibrateButton: HTMLButtonElement | null = null;
    private saveButtonMode: 'default' | 'force-degraded' = 'default';
    private isFixedPosition = false;
    private dedupeObserver: MutationObserver | null = null;
    private onSaveClick: () => Promise<void>;
    private onCalibrateClick: () => Promise<void>;

    constructor(
        onSaveClick: () => Promise<void>,
        onCopyClick: () => Promise<void>,
        onCalibrateClick: () => Promise<void>,
    ) {
        this.onSaveClick = onSaveClick;
        void onCopyClick;
        this.onCalibrateClick = onCalibrateClick;
        this.injectStyles();
    }

    public inject(target: HTMLElement, conversationId: string | null): void {
        if (this.container && document.contains(this.container)) {
            this.cleanupDuplicateControlIds(this.container);
            return;
        }

        this.cleanupOrphanedControls();

        this.container = this.createContainer();
        this.lifecycleBadge = this.createLifecycleBadge();
        this.saveStartButton = this.createButton('save', '💾', this.onSaveClick);
        this.calibrateButton = this.createButton('calibrate', '🧪', this.onCalibrateClick);

        if (this.container && this.lifecycleBadge && this.saveStartButton && this.calibrateButton) {
            this.container.appendChild(this.lifecycleBadge);
            this.container.appendChild(this.saveStartButton);
            this.container.appendChild(this.calibrateButton);

            // Fixed position fallback logic
            if (target === document.body || target === document.documentElement) {
                this.isFixedPosition = true;
                this.updateContainerStyles();
            } else {
                this.isFixedPosition = false;
                this.container.style.cssText = this.getContainerStyles('default');
            }

            target.appendChild(this.container);
            this.cleanupDuplicateControlIds(this.container);
            this.ensureDedupeObserver();
            logger.info(`Save/Calibrate buttons injected for conversation: ${conversationId}`);
        }
    }

    public remove(): void {
        this.disconnectDedupeObserver();
        if (this.container?.parentElement) {
            this.container.parentElement.removeChild(this.container);
        }
        this.container = null;
        this.lifecycleBadge = null;
        this.saveStartButton = null;
        this.calibrateButton = null;
    }

    public exists(): boolean {
        return !!this.container && document.contains(this.container);
    }

    public setReadinessSource(source: 'legacy' | 'sfe'): void {
        if (!this.container) {
            return;
        }
        this.container.setAttribute('data-readiness-source', source);
    }

    public setLoading(loading: boolean, _action: 'save'): void {
        if (!this.saveStartButton) {
            return;
        }

        const activeBtn = this.saveStartButton;

        activeBtn.disabled = loading;

        activeBtn.replaceChildren();

        if (loading) {
            activeBtn.textContent = '⏳';
            activeBtn.title = 'Saving...';
            activeBtn.style.opacity = '0.8';
        } else {
            this.renderDefaultButton('save');
        }
    }

    public setOpacity(opacity: string): void {
        if (this.saveStartButton) {
            this.saveStartButton.style.opacity = opacity;
        }
    }

    public setActionButtonsEnabled(enabled: boolean): void {
        if (this.saveStartButton) {
            this.saveStartButton.disabled = !enabled;
        }
    }

    public setButtonEnabled(action: 'save', enabled: boolean): void {
        const target = action === 'save' ? this.saveStartButton : null;
        if (!target) {
            return;
        }
        target.disabled = !enabled;
    }

    public setSaveButtonMode(mode: 'default' | 'force-degraded'): void {
        this.saveButtonMode = mode;
        this.renderDefaultButton('save');
    }

    public setCalibrationState(
        state: 'idle' | 'waiting' | 'capturing' | 'success' | 'error',
        options?: { timestampLabel?: string | null },
    ): void {
        if (!this.calibrateButton) {
            return;
        }

        this.calibrateButton.disabled = state === 'capturing';
        this.calibrateButton.style.opacity = state === 'capturing' ? '0.85' : '1';
        this.calibrateButton.style.cursor = state === 'capturing' ? 'wait' : 'pointer';
        this.calibrateButton.replaceChildren();

        if (state === 'waiting') {
            this.calibrateButton.textContent = '✅';
            this.calibrateButton.title = 'Calibrate (Done)';
            this.calibrateButton.style.background = 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)';
        } else if (state === 'capturing') {
            this.calibrateButton.textContent = '⏳';
            this.calibrateButton.title = 'Calibrating...';
            this.calibrateButton.style.background = 'linear-gradient(135deg, #6b7280 0%, #4b5563 100%)';
        } else if (state === 'success') {
            this.calibrateButton.textContent = '✅';
            this.calibrateButton.title = options?.timestampLabel
                ? `Calibrated (${options.timestampLabel})`
                : 'Calibrated';
            this.calibrateButton.style.background = 'linear-gradient(135deg, #10a37f 0%, #0d8a6a 100%)';
        } else if (state === 'error') {
            this.calibrateButton.textContent = '⚠️';
            this.calibrateButton.title = 'Calibrate (Retry)';
            this.calibrateButton.style.background = 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)';
        } else {
            this.calibrateButton.textContent = '🧪';
            this.calibrateButton.title = 'Calibrate';
            this.calibrateButton.style.background = 'linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%)';
        }
    }

    public setLifecycleState(state: 'idle' | 'prompt-sent' | 'streaming' | 'completed'): void {
        if (!this.lifecycleBadge) {
            return;
        }

        const stylesByState: Record<string, { label: string; background: string; border: string; color: string }> = {
            idle: {
                label: 'Idle',
                background: 'rgba(107, 114, 128, 0.16)',
                border: 'rgba(107, 114, 128, 0.45)',
                color: '#374151',
            },
            'prompt-sent': {
                label: 'Prompt Sent',
                background: 'rgba(37, 99, 235, 0.14)',
                border: 'rgba(37, 99, 235, 0.5)',
                color: '#1d4ed8',
            },
            streaming: {
                label: 'Streaming',
                background: 'rgba(217, 119, 6, 0.14)',
                border: 'rgba(217, 119, 6, 0.45)',
                color: '#b45309',
            },
            completed: {
                label: 'Completed',
                background: 'rgba(16, 163, 127, 0.14)',
                border: 'rgba(16, 163, 127, 0.45)',
                color: '#0d8a6a',
            },
        };

        const next = stylesByState[state];
        this.lifecycleBadge.textContent = next.label;
        this.lifecycleBadge.style.background = next.background;
        this.lifecycleBadge.style.borderColor = next.border;
        this.lifecycleBadge.style.color = next.color;
    }

    private createContainer(): HTMLElement {
        const div = document.createElement('div');
        div.id = 'blackiya-button-container';
        div.setAttribute('data-blackiya-controls', '1');
        div.style.cssText = this.getContainerStyles('default');
        return div;
    }

    private isElementNode(value: unknown): value is HTMLElement {
        return (
            !!value &&
            typeof value === 'object' &&
            (value as { nodeType?: number }).nodeType === 1 &&
            'style' in (value as Record<string, unknown>)
        );
    }

    private isControlContainer(node: Element | null): node is HTMLElement {
        return (
            !!node &&
            this.isElementNode(node) &&
            (node.id === 'blackiya-button-container' || node.getAttribute('data-blackiya-controls') === '1')
        );
    }

    private findControlContainer(node: Element | null): HTMLElement | null {
        let cursor: Element | null = node;
        while (cursor) {
            if (this.isControlContainer(cursor)) {
                return cursor;
            }
            cursor = cursor.parentElement;
        }
        return null;
    }

    private detachNode(node: HTMLElement): void {
        const parent = node.parentNode;
        if (parent) {
            parent.removeChild(node);
        }
    }

    private collectSearchRoots(): ParentNode[] {
        const roots: ParentNode[] = [];
        const queue: ParentNode[] = [document];
        const visited = new Set<ParentNode>();

        while (queue.length > 0) {
            const root = queue.shift();
            if (!root || visited.has(root)) {
                continue;
            }
            visited.add(root);
            roots.push(root);

            const elements = root.querySelectorAll('*');
            for (const element of elements) {
                if (!this.isElementNode(element) || !('shadowRoot' in element) || !element.shadowRoot) {
                    continue;
                }
                queue.push(element.shadowRoot);
            }
        }

        return roots;
    }

    private queryAllAcrossRoots(selector: string): HTMLElement[] {
        const matches: HTMLElement[] = [];
        for (const root of this.collectSearchRoots()) {
            const nodes = root.querySelectorAll(selector);
            for (const node of nodes) {
                if (this.isElementNode(node)) {
                    matches.push(node);
                }
            }
        }
        return matches;
    }

    private queryControlContainersAcrossRoots(): HTMLElement[] {
        const byId = this.queryAllAcrossRoots('#blackiya-button-container');
        const byAttr = this.queryAllAcrossRoots('[data-blackiya-controls="1"]');
        const seen = new Set<HTMLElement>();
        const unique: HTMLElement[] = [];
        for (const element of [...byId, ...byAttr]) {
            if (seen.has(element)) {
                continue;
            }
            seen.add(element);
            unique.push(element);
        }
        return unique;
    }

    private collectPrimaryControls(activeContainer: HTMLElement): Set<HTMLElement> {
        const keep = new Set<HTMLElement>();
        for (const id of this.controlIds) {
            const primary = activeContainer.querySelector(`#${id}`);
            if (this.isElementNode(primary)) {
                keep.add(primary);
            }
        }
        return keep;
    }

    private removeDuplicateContainers(activeContainer: HTMLElement): void {
        const allContainers = this.queryControlContainersAcrossRoots();
        for (const container of allContainers) {
            if (container === activeContainer) {
                continue;
            }
            this.detachNode(container);
        }
    }

    private removeDuplicateControlById(id: string, keep: Set<HTMLElement>, activeContainer: HTMLElement): void {
        const matches = this.queryAllAcrossRoots(`#${id}`);
        for (const match of matches) {
            if (keep.has(match)) {
                continue;
            }
            const parentContainer = this.findControlContainer(match);
            this.detachNode(match);
            if (parentContainer && parentContainer !== activeContainer) {
                const hasRemainingControls = this.controlIds.some(
                    (controlId) => !!parentContainer.querySelector(`#${controlId}`),
                );
                if (!hasRemainingControls) {
                    this.detachNode(parentContainer);
                }
            }
        }
    }

    private cleanupOrphanedControls(): void {
        // V2.1-034 hardening: extension reloads can leave stale controls with
        // older DOM shapes. Remove all known control roots before injecting.
        const staleContainers = this.queryControlContainersAcrossRoots();
        for (const container of staleContainers) {
            this.detachNode(container);
        }

        for (const id of this.controlIds) {
            const elements = this.queryAllAcrossRoots(`#${id}`);
            for (const element of elements) {
                const parentContainer = this.findControlContainer(element);
                if (!parentContainer) {
                    this.detachNode(element);
                }
            }
        }
    }

    private cleanupDuplicateControlIds(activeContainer: HTMLElement): void {
        const keep = this.collectPrimaryControls(activeContainer);
        this.removeDuplicateContainers(activeContainer);
        for (const id of this.controlIds) {
            this.removeDuplicateControlById(id, keep, activeContainer);
        }
    }

    private ensureDedupeObserver(): void {
        if (this.dedupeObserver || !this.container || !document.body || typeof MutationObserver === 'undefined') {
            return;
        }
        this.dedupeObserver = new MutationObserver(() => {
            if (!this.container || !document.contains(this.container)) {
                this.disconnectDedupeObserver();
                return;
            }
            this.cleanupDuplicateControlIds(this.container);
        });
        this.dedupeObserver.observe(document.body, {
            childList: true,
            subtree: true,
        });
    }

    private disconnectDedupeObserver(): void {
        if (!this.dedupeObserver) {
            return;
        }
        this.dedupeObserver.disconnect();
        this.dedupeObserver = null;
    }

    private createLifecycleBadge(): HTMLElement {
        const badge = document.createElement('div');
        badge.id = 'blackiya-lifecycle-badge';
        badge.style.cssText = `
            display: inline-flex;
            align-items: center;
            justify-content: center;
            height: 32px;
            padding: 0 10px;
            border-radius: 6px;
            border: 1px solid rgba(107, 114, 128, 0.45);
            background: rgba(107, 114, 128, 0.16);
            color: #374151;
            font-size: 12px;
            font-weight: 600;
            letter-spacing: 0.01em;
            white-space: nowrap;
        `;
        badge.textContent = 'Idle';
        return badge;
    }

    private createButton(type: 'save' | 'calibrate', label: string, onClick: () => Promise<void>): HTMLButtonElement {
        const button = document.createElement('button');
        button.id = `blackiya-${type}-btn`;
        button.textContent = label;
        button.title = type === 'save' ? 'Save JSON' : 'Calibrate';
        button.setAttribute('aria-label', button.title);

        button.style.cssText = this.getButtonDefaultStyles(type);

        button.addEventListener('mouseenter', () => {
            if (!button.disabled) {
                button.style.transform = 'translateY(-1px)';
                button.style.boxShadow = '0 4px 8px rgba(16, 163, 127, 0.3)';
            }
        });

        button.addEventListener('mouseleave', () => {
            if (!button.disabled) {
                button.style.transform = 'none';
                button.style.boxShadow = 'none';
            }
        });

        button.addEventListener('click', onClick);

        return button;
    }

    private updateContainerStyles(): void {
        if (!this.container) {
            return;
        }
        this.container.style.cssText = this.getContainerStyles('default');
    }

    private getContainerStyles(_state: 'default'): string {
        let css = `
            display: inline-flex;
            align-items: center;
            gap: 8px;
            margin-left: 8px;
            z-index: 9999;
        `;

        if (this.isFixedPosition) {
            css += `
                position: fixed;
                bottom: 20px;
                right: 20px;
                z-index: 10000;
                padding: 10px;
                background: rgba(30,30,30,0.8);
                backdrop-filter: blur(4px);
                border-radius: 12px;
                box-shadow: 0 4px 12px rgba(0,0,0,0.15);
            `;
        }

        return css;
    }

    private getButtonDefaultStyles(type: 'save' | 'calibrate'): string {
        const bg =
            type === 'calibrate'
                ? 'linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%)'
                : 'linear-gradient(135deg, #10a37f 0%, #0d8a6a 100%)';
        return `
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 32px;
            height: 32px;
            padding: 0;
            border: none;
            border-radius: 6px;
            background: ${bg};
            color: #fff;
            font-size: 16px;
            font-weight: 600;
            line-height: 1;
            cursor: pointer;
            transition: all 0.2s ease;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            opacity: 1;
        `;
    }

    public setSuccess(action: 'save'): void {
        void action;
        const activeBtn = this.saveStartButton;
        if (!activeBtn) {
            return;
        }

        activeBtn.disabled = true;
        activeBtn.textContent = '✅';
        activeBtn.title = 'Saved';
        activeBtn.style.opacity = '1';

        setTimeout(() => {
            if (activeBtn) {
                activeBtn.disabled = false;
                this.renderDefaultButton('save');
            }
        }, 2000);
    }

    private getDefaultLabel(action: 'save'): string {
        void action;
        return '💾';
    }

    private renderDefaultButton(action: 'save'): void {
        const button = this.saveStartButton;
        if (!button) {
            return;
        }

        button.textContent = this.getDefaultLabel(action);
        button.style.opacity = '1';
        button.style.background =
            this.saveButtonMode === 'force-degraded'
                ? 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)'
                : 'linear-gradient(135deg, #10a37f 0%, #0d8a6a 100%)';
        button.title = this.saveButtonMode === 'force-degraded' ? 'Force Save (partial data possible)' : 'Save JSON';
        button.setAttribute('aria-label', button.title);
    }

    private injectStyles(): void {
        const styleId = 'blackiya-button-styles';
        if (document.getElementById(styleId)) {
            return;
        }

        const style = document.createElement('style');
        style.id = styleId;
        style.textContent = `
            @keyframes spin {
                from { transform: rotate(0deg); }
                to { transform: rotate(360deg); }
            }
        `;
        document.head.appendChild(style);
    }
}
