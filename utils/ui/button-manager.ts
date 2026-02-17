/**
 * Button Manager Utility
 *
 * Handles the creation, styling, injecting, and state management of the UI buttons (Save JSON, Copy JSON).
 */
import { logger } from '@/utils/logger';

export class ButtonManager {
    private readonly controlIds = [
        'blackiya-lifecycle-badge',
        'blackiya-save-btn',
        'blackiya-copy-btn',
        'blackiya-calibrate-btn',
    ];
    private container: HTMLElement | null = null;
    private lifecycleBadge: HTMLElement | null = null;
    private saveStartButton: HTMLButtonElement | null = null;
    private copyButton: HTMLButtonElement | null = null;
    private calibrateButton: HTMLButtonElement | null = null;
    private saveButtonMode: 'default' | 'force-degraded' = 'default';
    private isFixedPosition = false;
    private dedupeObserver: MutationObserver | null = null;
    private onSaveClick: () => Promise<void>;
    private onCopyClick: () => Promise<void>;
    private onCalibrateClick: () => Promise<void>;

    constructor(
        onSaveClick: () => Promise<void>,
        onCopyClick: () => Promise<void>,
        onCalibrateClick: () => Promise<void>,
    ) {
        this.onSaveClick = onSaveClick;
        this.onCopyClick = onCopyClick;
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
        this.saveStartButton = this.createButton('save', 'Save JSON', this.onSaveClick);
        this.copyButton = this.createButton('copy', 'Copy', this.onCopyClick);
        this.calibrateButton = this.createButton('calibrate', 'Calibrate', this.onCalibrateClick);

        if (this.container && this.lifecycleBadge && this.saveStartButton && this.copyButton && this.calibrateButton) {
            this.container.appendChild(this.lifecycleBadge);
            this.container.appendChild(this.saveStartButton);
            this.container.appendChild(this.copyButton);
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
            logger.info(`Save/Copy buttons injected for conversation: ${conversationId}`);
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
        this.copyButton = null;
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

    public setLoading(loading: boolean, action: 'save' | 'copy'): void {
        if (!this.saveStartButton || !this.copyButton) {
            return;
        }

        const activeBtn = action === 'save' ? this.saveStartButton : this.copyButton;
        const otherBtn = action === 'save' ? this.copyButton : this.saveStartButton;

        activeBtn.disabled = loading;
        otherBtn.disabled = loading; // Disable both to prevent conflict

        activeBtn.replaceChildren();

        if (loading) {
            const icon = this.createIconSVG('loading');
            const textSpan = document.createElement('span');
            textSpan.textContent = action === 'save' ? 'Saving...' : 'Copying...';
            activeBtn.appendChild(icon);
            activeBtn.appendChild(textSpan);
            activeBtn.style.opacity = '0.8';
        } else {
            this.renderDefaultButton(action);
        }
    }

    public setOpacity(opacity: string): void {
        if (this.saveStartButton) {
            this.saveStartButton.style.opacity = opacity;
        }
        if (this.copyButton) {
            this.copyButton.style.opacity = opacity;
        }
    }

    public setActionButtonsEnabled(enabled: boolean): void {
        if (this.saveStartButton) {
            this.saveStartButton.disabled = !enabled;
        }
        if (this.copyButton) {
            this.copyButton.disabled = !enabled;
        }
    }

    public setButtonEnabled(action: 'save' | 'copy', enabled: boolean): void {
        const target = action === 'save' ? this.saveStartButton : this.copyButton;
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

        const iconType = state === 'capturing' ? 'loading' : state === 'success' ? 'check' : 'calibrate';
        const icon = this.createIconSVG(iconType);
        const text = document.createElement('span');

        if (state === 'waiting') {
            text.textContent = 'Done';
            this.calibrateButton.style.background = 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)';
        } else if (state === 'capturing') {
            text.textContent = 'Capturing...';
            this.calibrateButton.style.background = 'linear-gradient(135deg, #6b7280 0%, #4b5563 100%)';
        } else if (state === 'success') {
            text.textContent = options?.timestampLabel ? `Captured • ${options.timestampLabel}` : 'Captured';
            this.calibrateButton.style.background = 'linear-gradient(135deg, #10a37f 0%, #0d8a6a 100%)';
        } else if (state === 'error') {
            text.textContent = 'Retry';
            this.calibrateButton.style.background = 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)';
        } else {
            text.textContent = 'Calibrate';
            this.calibrateButton.style.background = 'linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%)';
        }

        this.calibrateButton.appendChild(icon);
        this.calibrateButton.appendChild(text);
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

    private createButton(
        type: 'save' | 'copy' | 'calibrate',
        label: string,
        onClick: () => Promise<void>,
    ): HTMLButtonElement {
        const button = document.createElement('button');
        button.id = `blackiya-${type}-btn`;

        const icon = this.createIconSVG(type);
        const textSpan = document.createElement('span');
        textSpan.textContent = label;

        button.appendChild(icon);
        button.appendChild(textSpan);

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

    private getButtonDefaultStyles(type: 'save' | 'copy' | 'calibrate'): string {
        const bg =
            type === 'calibrate'
                ? 'linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%)'
                : 'linear-gradient(135deg, #10a37f 0%, #0d8a6a 100%)';
        return `
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 6px;
            padding: 8px 12px;
            border: none;
            border-radius: 6px;
            background: ${bg};
            color: #fff;
            font-size: 13px;
            font-weight: 500;
            min-width: 96px;
            cursor: pointer;
            transition: all 0.2s ease;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            opacity: 1;
        `;
    }

    public setSuccess(action: 'save' | 'copy'): void {
        const activeBtn = action === 'save' ? this.saveStartButton : this.copyButton;
        const otherBtn = action === 'save' ? this.copyButton : this.saveStartButton;

        if (!activeBtn || !otherBtn) {
            return;
        }

        // Clear any previous state
        activeBtn.replaceChildren();
        activeBtn.disabled = true;
        otherBtn.disabled = true;

        const icon = this.createIconSVG('check');
        const textSpan = document.createElement('span');
        textSpan.textContent = action === 'save' ? 'Saved!' : 'Copied!';

        activeBtn.appendChild(icon);
        activeBtn.appendChild(textSpan);
        activeBtn.style.opacity = '1';

        // Reset back after 2 seconds
        setTimeout(() => {
            if (activeBtn && otherBtn) {
                activeBtn.disabled = false;
                otherBtn.disabled = false;
                this.renderDefaultButton(action);
                this.renderDefaultButton(action === 'save' ? 'copy' : 'save');
            }
        }, 2000);
    }

    private getDefaultLabel(action: 'save' | 'copy'): string {
        if (action === 'copy') {
            return 'Copy';
        }
        return this.saveButtonMode === 'force-degraded' ? 'Force Save' : 'Save JSON';
    }

    private renderDefaultButton(action: 'save' | 'copy'): void {
        const button = action === 'save' ? this.saveStartButton : this.copyButton;
        if (!button) {
            return;
        }

        button.replaceChildren();
        const icon = this.createIconSVG(action);
        const text = document.createElement('span');
        text.textContent = this.getDefaultLabel(action);
        button.appendChild(icon);
        button.appendChild(text);
        button.style.opacity = '1';
        if (action === 'save') {
            button.style.background =
                this.saveButtonMode === 'force-degraded'
                    ? 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)'
                    : 'linear-gradient(135deg, #10a37f 0%, #0d8a6a 100%)';
        }
    }

    private createIconSVG(iconType: 'save' | 'copy' | 'calibrate' | 'loading' | 'check'): SVGSVGElement {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('width', '16');
        svg.setAttribute('height', '16');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '2');
        svg.setAttribute('stroke-linecap', 'round');
        svg.setAttribute('stroke-linejoin', 'round');

        if (iconType === 'loading') {
            svg.style.animation = 'spin 1s linear infinite';
            const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            circle.setAttribute('cx', '12');
            circle.setAttribute('cy', '12');
            circle.setAttribute('r', '10');
            circle.setAttribute('stroke-dasharray', '32');
            circle.setAttribute('stroke-dashoffset', '8');
            svg.appendChild(circle);
        } else if (iconType === 'check') {
            const polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
            polyline.setAttribute('points', '20 6 9 17 4 12');
            svg.appendChild(polyline);
        } else if (iconType === 'save') {
            // Save/Download icon
            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('d', 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4');
            const polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
            polyline.setAttribute('points', '7 10 12 15 17 10');
            const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            line.setAttribute('x1', '12');
            line.setAttribute('y1', '15');
            line.setAttribute('x2', '12');
            line.setAttribute('y2', '3');
            svg.appendChild(path);
            svg.appendChild(polyline);
            svg.appendChild(line);
        } else if (iconType === 'calibrate') {
            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('d', 'M12 2l1.8 4.2L18 8l-4.2 1.8L12 14l-1.8-4.2L6 8l4.2-1.8L12 2z');
            const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            line.setAttribute('x1', '19');
            line.setAttribute('y1', '19');
            line.setAttribute('x2', '19');
            line.setAttribute('y2', '19');
            svg.appendChild(path);
            svg.appendChild(line);
        } else {
            // Copy Icon
            const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
            rect.setAttribute('x', '9');
            rect.setAttribute('y', '9');
            rect.setAttribute('width', '13');
            rect.setAttribute('height', '13');
            rect.setAttribute('rx', '2');
            rect.setAttribute('ry', '2');
            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('d', 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1');
            svg.appendChild(rect);
            svg.appendChild(path);
        }
        return svg;
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
