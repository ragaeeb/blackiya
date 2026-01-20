/**
 * Button Manager Utility
 *
 * Handles the creation, styling, injecting, and state management of the "Save JSON" button.
 * Decoupled from data processing logic.
 */
import { logger } from '@/utils/logger';

export class ButtonManager {
    private button: HTMLButtonElement | null = null;
    private isFixedPosition = false;
    private currentOpacity = '1';
    private onSaveClick: () => Promise<void>;

    constructor(onSaveClick: () => Promise<void>) {
        this.onSaveClick = onSaveClick;
        this.injectStyles();
    }

    public inject(target: HTMLElement, conversationId: string | null): void {
        if (this.button && document.contains(this.button)) {
            return;
        }

        this.button = this.createButton();

        // Fixed position fallback logic
        if (target === document.body || target === document.documentElement) {
            this.isFixedPosition = true;
            this.updateStyles('default');
        } else {
            this.isFixedPosition = false;
            // Reset to default inline styles if previously fixed
            this.button.style.cssText = this.getStyles('default');
        }

        target.appendChild(this.button);
        logger.info(`Save button injected for conversation: ${conversationId}`);
    }

    public remove(): void {
        if (this.button?.parentElement) {
            this.button.parentElement.removeChild(this.button);
        }
        this.button = null;
    }

    public exists(): boolean {
        return !!this.button && document.contains(this.button);
    }

    public setLoading(loading: boolean): void {
        if (!this.button) {
            return;
        }

        this.button.disabled = loading;
        this.button.disabled = loading;
        this.button.replaceChildren();

        if (loading) {
            const icon = this.createIconSVG('loading');
            const textSpan = document.createElement('span');
            textSpan.textContent = 'Saving...';
            this.button.appendChild(icon);
            this.button.appendChild(textSpan);
            this.updateStyles('loading');
        } else {
            const icon = this.createIconSVG('save');
            const textSpan = document.createElement('span');
            textSpan.textContent = 'Save JSON';
            this.button.appendChild(icon);
            this.button.appendChild(textSpan);
            this.updateStyles('default');
        }
    }

    public setOpacity(opacity: string): void {
        this.currentOpacity = opacity;
        if (this.button) {
            this.button.style.opacity = opacity;
        }
    }

    private createButton(): HTMLButtonElement {
        const button = document.createElement('button');
        button.id = 'llm-capture-save-btn';

        const icon = this.createIconSVG('save');
        const textSpan = document.createElement('span');
        textSpan.textContent = 'Save JSON';

        button.appendChild(icon);
        button.appendChild(textSpan);

        button.style.cssText = this.getStyles('default');

        button.addEventListener('mouseenter', () => {
            if (!button.disabled) {
                this.updateStyles('hover');
            }
        });

        button.addEventListener('mouseleave', () => {
            if (!button.disabled) {
                this.updateStyles('default');
            }
        });

        button.addEventListener('click', this.onSaveClick);

        // If we have an ID but no data yet (handled by caller logic typically,
        // but here we just set initial opacity if passed)
        // logic moved to orchestration, but keeping opacity control public

        return button;
    }

    private updateStyles(state: 'default' | 'hover' | 'loading'): void {
        if (!this.button) {
            return;
        }
        this.button.style.cssText = this.getStyles(state);
    }

    private getStyles(state: 'default' | 'hover' | 'loading'): string {
        let css = `
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 8px 14px;
            margin-left: 8px;
            border: none;
            border-radius: 8px;
            background: linear-gradient(135deg, #10a37f 0%, #0d8a6a 100%);
            color: white;
            font-size: 13px;
            font-weight: 500;
            cursor: pointer;
            transition: all 0.2s ease;
            box-shadow: 0 2px 4px rgba(16, 163, 127, 0.2);
            z-index: 9999;
            opacity: ${this.currentOpacity};
        `;

        if (state === 'hover') {
            css += `
                background: linear-gradient(135deg, #0d8a6a 0%, #0a7359 100%);
                box-shadow: 0 4px 8px rgba(16, 163, 127, 0.3);
                transform: translateY(-1px);
            `;
        } else if (state === 'loading') {
            css += `
                opacity: 0.7;
                cursor: wait;
            `;
        }

        if (this.isFixedPosition) {
            css += `
                position: fixed;
                bottom: 20px;
                right: 20px;
                z-index: 10000;
                box-shadow: 0 4px 12px rgba(0,0,0,0.15);
            `;
        }

        return css;
    }

    private createIconSVG(iconType: 'save' | 'loading'): SVGSVGElement {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('width', '16');
        svg.setAttribute('height', '16');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '2');

        if (iconType === 'loading') {
            svg.style.animation = 'spin 1s linear infinite';
            const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            circle.setAttribute('cx', '12');
            circle.setAttribute('cy', '12');
            circle.setAttribute('r', '10');
            circle.setAttribute('stroke-dasharray', '32');
            circle.setAttribute('stroke-dashoffset', '8');
            svg.appendChild(circle);
        } else {
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
