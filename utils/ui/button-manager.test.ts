import { beforeEach, describe, expect, it, mock } from 'bun:test';
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

import { ButtonManager } from './button-manager';

describe('ButtonManager', () => {
    const windowInstance = new Window();
    const document = windowInstance.document;
    const listById = (id: string, root: any = document): any[] => {
        const matches: any[] = [];
        const queue: any[] = [root];
        while (queue.length > 0) {
            const current = queue.shift();
            if (!current || typeof current !== 'object') {
                continue;
            }
            if (current.id === id) {
                matches.push(current);
            }
            if (current.shadowRoot) {
                queue.push(current.shadowRoot);
            }
            const children = current.children;
            if (!children || typeof children.length !== 'number') {
                continue;
            }
            for (let i = 0; i < children.length; i += 1) {
                queue.push(children.item(i));
            }
        }
        return matches;
    };
    const countById = (id: string, root: any = document): number => listById(id, root).length;

    beforeEach(() => {
        document.body.innerHTML = '';
        (global as any).window = windowInstance;
        (global as any).document = document;
    });

    it('keeps calibrate enabled when action buttons are disabled', () => {
        const manager = new ButtonManager(
            async () => {},
            async () => {},
        );
        manager.inject(document.body as any, null);

        manager.setActionButtonsEnabled(false);
        manager.setCalibrationState('idle');

        const saveBtn = document.getElementById('blackiya-save-btn') as HTMLButtonElement | null;
        const calibrateBtn = document.getElementById('blackiya-calibrate-btn') as HTMLButtonElement | null;

        expect(saveBtn?.disabled).toBeTrue();
        expect(calibrateBtn?.disabled).toBeFalse();
        expect(calibrateBtn?.style.opacity).toBe('1');
    });

    it('dims calibrate only while capturing and restores opacity after', () => {
        const manager = new ButtonManager(
            async () => {},
            async () => {},
        );
        manager.inject(document.body as any, '123');

        manager.setCalibrationState('capturing');
        const calibrateBtn = document.getElementById('blackiya-calibrate-btn') as HTMLButtonElement | null;
        expect(calibrateBtn?.disabled).toBeTrue();
        expect(calibrateBtn?.style.opacity).toBe('0.85');

        manager.setCalibrationState('idle');
        expect(calibrateBtn?.disabled).toBeFalse();
        expect(calibrateBtn?.style.opacity).toBe('1');
    });

    it('shows friendly calibration timestamp when provided in success state', () => {
        const manager = new ButtonManager(
            async () => {},
            async () => {},
        );
        manager.inject(document.body as any, '123');

        manager.setCalibrationState('success', { timestampLabel: '5m ago' });
        const calibrateBtn = document.getElementById('blackiya-calibrate-btn') as HTMLButtonElement | null;

        expect(calibrateBtn?.textContent).toContain('✅');
        expect(calibrateBtn?.title).toContain('5m ago');
    });

    it('cleans up orphaned containers from previous extension contexts (V2.1-034)', () => {
        // Simulate an orphaned container left by a previous extension reload
        const orphan = document.createElement('div');
        orphan.id = 'blackiya-button-container';
        orphan.textContent = 'orphan';
        document.body.appendChild(orphan);

        // A second orphan to ensure ALL are cleaned
        const orphan2 = document.createElement('div');
        orphan2.id = 'blackiya-button-container';
        orphan2.textContent = 'orphan2';
        document.body.appendChild(orphan2);

        expect(countById('blackiya-button-container')).toBe(2);

        const manager = new ButtonManager(
            async () => {},
            async () => {},
        );
        manager.inject(document.body as any, 'test-123');

        // After injection, there should be exactly ONE container (the new one)
        const containers = listById('blackiya-button-container');
        expect(containers.length).toBe(1);
        expect(containers[0]!.textContent).not.toContain('orphan');
        expect(containers[0]!.getAttribute('data-blackiya-controls')).toBe('1');
    });

    it('removes stale standalone control nodes before reinjection', () => {
        const staleSave = document.createElement('button');
        staleSave.id = 'blackiya-save-btn';
        staleSave.textContent = 'stale save';
        document.body.appendChild(staleSave);

        const manager = new ButtonManager(
            async () => {},
            async () => {},
        );
        manager.inject(document.body as any, 'test-standalone');

        const saveButtons = listById('blackiya-save-btn');
        expect(saveButtons.length).toBe(1);
        expect(saveButtons[0]?.textContent?.includes('stale')).toBeFalse();
    });

    it('does not re-inject when container already exists in DOM', () => {
        const manager = new ButtonManager(
            async () => {},
            async () => {},
        );
        manager.inject(document.body as any, 'test-123');

        const firstContainer = document.getElementById('blackiya-button-container');
        expect(firstContainer).not.toBeNull();

        // Second inject should be a no-op
        manager.inject(document.body as any, 'test-456');

        const containers = listById('blackiya-button-container');
        expect(containers.length).toBe(1);
    });

    it('cleans duplicate control IDs even when inject is a no-op', () => {
        const manager = new ButtonManager(
            async () => {},
            async () => {},
        );
        manager.inject(document.body as any, 'test-dup-noop');

        // Simulate a duplicate stale button outside the active container
        const duplicateSave = document.createElement('button');
        duplicateSave.id = 'blackiya-save-btn';
        duplicateSave.textContent = 'duplicate save';
        document.body.appendChild(duplicateSave);

        expect(countById('blackiya-save-btn')).toBe(2);

        // Re-inject with same manager hits no-op path.
        manager.inject(document.body as any, 'test-dup-noop');

        const saveButtons = listById('blackiya-save-btn');
        expect(saveButtons.length).toBe(1);
        expect(saveButtons[0]?.textContent?.includes('duplicate')).toBeFalse();
    });

    it('removes duplicate controls injected inside a shadow root', () => {
        const manager = new ButtonManager(
            async () => {},
            async () => {},
        );
        manager.inject(document.body as any, 'shadow-dup');

        const host = document.createElement('div');
        const shadow = host.attachShadow({ mode: 'open' });
        const duplicateContainer = document.createElement('div');
        duplicateContainer.id = 'blackiya-button-container';
        duplicateContainer.setAttribute('data-blackiya-controls', '1');
        const duplicateSave = document.createElement('button');
        duplicateSave.id = 'blackiya-save-btn';
        duplicateSave.textContent = 'shadow duplicate save';
        duplicateContainer.appendChild(duplicateSave);
        shadow.appendChild(duplicateContainer);
        document.body.appendChild(host);

        manager.inject(document.body as any, 'shadow-dup');

        const saveButtons = listById('blackiya-save-btn');
        const shadowSaveButtons = listById('blackiya-save-btn', shadow);
        const containers = listById('blackiya-button-container');
        const shadowContainers = listById('blackiya-button-container', shadow);

        expect(saveButtons.length).toBe(1);
        expect(shadowSaveButtons.length).toBe(0);
        expect(containers.length).toBe(1);
        expect(shadowContainers.length).toBe(0);
    });

    it('shows lifecycle badge and updates phases', () => {
        const manager = new ButtonManager(
            async () => {},
            async () => {},
        );
        manager.inject(document.body as any, '123');

        const badge = document.getElementById('blackiya-lifecycle-badge') as HTMLElement | null;
        expect(badge).not.toBeNull();
        expect(badge?.textContent).toContain('Idle');

        manager.setLifecycleState('prompt-sent');
        expect(badge?.textContent).toContain('Prompt Sent');

        manager.setLifecycleState('streaming');
        expect(badge?.textContent).toContain('Streaming');

        manager.setLifecycleState('completed');
        expect(badge?.textContent).toContain('Completed');
    });
});
