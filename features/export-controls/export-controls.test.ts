import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { Window } from 'happy-dom';

const loggerSpies = {
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
};

mock.module('@/utils/logger', () => ({
    logger: loggerSpies,
}));

import {
    DESCOPED_CONTROL_IDS,
    EXPORT_CHAT_BUTTON_ID,
    EXPORT_CONTROLS_CONTAINER_ATTR,
    EXPORT_CONTROLS_CONTAINER_ID,
    EXPORT_ERROR_KIND_ATTR,
    type ExportControlsDependencies,
} from './contract';
import { createExportControls } from './export-controls';

const flushMicrotasks = async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
};

const createDependencies = (): ExportControlsDependencies => {
    return {
        resolveActionContext: mock(() => ({ platform: 'chatgpt', conversationId: 'conv-1' })),
        onExport: mock(async () => {}),
    };
};

describe('v3 export controls', () => {
    let windowInstance: Window;
    let document: typeof windowInstance.document;
    const mounted: Array<{ destroy: () => void }> = [];

    beforeEach(() => {
        windowInstance = new Window();
        document = windowInstance.document;
        (globalThis as Record<string, unknown>).window = windowInstance;
        (globalThis as Record<string, unknown>).document = document;
        (globalThis as Record<string, unknown>).MutationObserver = windowInstance.MutationObserver;
        document.body.innerHTML = '';
    });

    afterEach(async () => {
        for (const controls of mounted.splice(0)) {
            controls.destroy();
        }
        await flushMicrotasks();
        delete (globalThis as Record<string, unknown>).MutationObserver;
    });

    const mount = (dependencies: ExportControlsDependencies = createDependencies()) => {
        const controls = createExportControls(dependencies, { successResetMs: 10, errorResetMs: 10 });
        mounted.push(controls);
        controls.mount();
        return { controls, dependencies };
    };

    it('should mount exactly one primary JSON save button fixed to document.body', () => {
        mount();

        const containers = document.querySelectorAll(`#${EXPORT_CONTROLS_CONTAINER_ID}`);
        expect(containers.length).toBe(1);

        const container = containers[0] as unknown as HTMLElement;
        expect((container.parentElement as unknown) === (document.body as unknown)).toBe(true);
        expect(container.getAttribute(EXPORT_CONTROLS_CONTAINER_ATTR)).toBe('1');
        expect(container.style.position).toBe('fixed');

        const buttons = container.querySelectorAll('button');
        expect(buttons.length).toBe(1);

        const button = buttons[0] as HTMLButtonElement;
        expect(button.id).toBe(EXPORT_CHAT_BUTTON_ID);
        expect(button.textContent).toBe('Save JSON');
        expect(button.disabled).toBe(false);
    });

    it('should not render any descoped controls', () => {
        mount();

        for (const legacyId of DESCOPED_CONTROL_IDS) {
            expect(document.querySelectorAll(`#${legacyId}`).length).toBe(0);
            expect(document.getElementById(legacyId)?.textContent ?? null).toBeNull();
        }
        expect(document.body.textContent).not.toContain('Markdown');
        expect(document.body.textContent).not.toContain('Calibrate');
        expect(document.querySelector('#blackiya-button-container')).toBeNull();
    });

    it('should remove stale duplicate containers before mounting', () => {
        const stale = document.createElement('div');
        stale.id = EXPORT_CONTROLS_CONTAINER_ID;
        stale.setAttribute(EXPORT_CONTROLS_CONTAINER_ATTR, '1');
        document.body.appendChild(stale);

        const orphanButton = document.createElement('button');
        orphanButton.id = EXPORT_CHAT_BUTTON_ID;
        stale.appendChild(orphanButton);

        mount();

        expect(document.querySelectorAll(`#${EXPORT_CONTROLS_CONTAINER_ID}`).length).toBe(1);
        expect(document.querySelectorAll(`#${EXPORT_CHAT_BUTTON_ID}`).length).toBe(1);
        expect(stale.isConnected).toBe(false);
    });

    it('should keep a single instance across repeated mounts', () => {
        const { controls } = mount();
        controls.mount();
        controls.mount();

        expect(document.querySelectorAll(`[${EXPORT_CONTROLS_CONTAINER_ATTR}="1"]`).length).toBe(1);
        expect(document.querySelectorAll('button').length).toBe(1);
    });

    it('should reinject the container into document.body when it is removed from the DOM', async () => {
        const { controls } = mount();
        const element = controls.getElement() as HTMLElement;

        element.remove();
        expect(element.isConnected).toBe(false);

        await flushMicrotasks();

        expect(element.isConnected).toBe(true);
        expect((element.parentElement as unknown) === (document.body as unknown)).toBe(true);
        expect(document.querySelectorAll(`#${EXPORT_CONTROLS_CONTAINER_ID}`).length).toBe(1);
    });

    it('should stop reinjecting after destroy', async () => {
        const { controls } = mount();
        const element = controls.getElement() as HTMLElement;

        controls.destroy();
        expect(element.isConnected).toBe(false);

        await flushMicrotasks();

        expect(element.isConnected).toBe(false);
        expect(document.querySelectorAll(`#${EXPORT_CONTROLS_CONTAINER_ID}`).length).toBe(0);
    });

    it('should resolve platform and conversation at action time, not mount time', async () => {
        const { controls, dependencies } = mount();

        expect(dependencies.resolveActionContext).toHaveBeenCalledTimes(0);

        const button = controls.getButton() as HTMLButtonElement;
        button.click();
        await flushMicrotasks();

        expect(dependencies.resolveActionContext).toHaveBeenCalledTimes(1);
        expect(dependencies.onExport).toHaveBeenCalledWith({ platform: 'chatgpt', conversationId: 'conv-1' });
    });

    it('should transition idle -> loading -> success -> idle', async () => {
        let releaseExport: () => void = () => {};
        const pendingExport = new Promise<void>((resolve) => {
            releaseExport = resolve;
        });
        const { controls } = mount({
            resolveActionContext: mock(() => ({ platform: 'grok', conversationId: null })),
            onExport: mock(() => pendingExport),
        });
        const button = controls.getButton() as HTMLButtonElement;

        button.click();
        expect(controls.getState()).toBe('loading');
        expect(button.disabled).toBe(true);
        expect(button.textContent).toBe('Saving…');

        releaseExport?.();
        await flushMicrotasks();

        expect(controls.getState()).toBe('success');
        expect(button.textContent).toBe('✓ Saved');
        expect(button.disabled).toBe(true);

        await new Promise((resolve) => setTimeout(resolve, 30));

        expect(controls.getState()).toBe('idle');
        expect(button.textContent).toBe('Save JSON');
        expect(button.disabled).toBe(false);
    });

    it('should transition idle -> loading -> error -> idle when export fails', async () => {
        const { controls } = mount({
            resolveActionContext: mock(() => ({ platform: 'gemini', conversationId: 'g-1' })),
            onExport: mock(async () => {
                throw Object.assign(new Error('boom'), { kind: 'not_terminal' });
            }),
        });
        const button = controls.getButton() as HTMLButtonElement;

        button.click();
        await flushMicrotasks();

        expect(controls.getState()).toBe('error');
        expect(button.textContent).toBe('⚠ Failed');
        expect(button.disabled).toBe(true);
        expect(button.getAttribute(EXPORT_ERROR_KIND_ATTR)).toBe('not_terminal');

        await new Promise((resolve) => setTimeout(resolve, 30));

        expect(controls.getState()).toBe('idle');
        expect(button.textContent).toBe('Save JSON');
        expect(button.disabled).toBe(false);
    });

    it('should ignore additional clicks while an export is in flight', async () => {
        let releaseExport: () => void = () => {};
        const pendingExport = new Promise<void>((resolve) => {
            releaseExport = resolve;
        });
        const onExport = mock(() => pendingExport);
        const { controls } = mount({
            resolveActionContext: mock(() => ({ platform: 'chatgpt', conversationId: 'c-1' })),
            onExport,
        });
        const button = controls.getButton() as HTMLButtonElement;

        button.click();
        button.click();
        button.click();
        await flushMicrotasks();

        expect(onExport).toHaveBeenCalledTimes(1);
        expect(controls.getState()).toBe('loading');

        releaseExport?.();
        await flushMicrotasks();
        expect(controls.getState()).toBe('success');
    });
});
