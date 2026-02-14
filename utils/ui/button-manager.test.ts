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

    beforeEach(() => {
        document.body.innerHTML = '';
        (global as any).window = windowInstance;
        (global as any).document = document;
    });

    it('keeps calibrate enabled when action buttons are disabled', () => {
        const manager = new ButtonManager(
            async () => {},
            async () => {},
            async () => {},
        );
        manager.inject(document.body as any, null);

        manager.setActionButtonsEnabled(false);
        manager.setCalibrationState('idle');

        const saveBtn = document.getElementById('blackiya-save-btn') as HTMLButtonElement | null;
        const copyBtn = document.getElementById('blackiya-copy-btn') as HTMLButtonElement | null;
        const calibrateBtn = document.getElementById('blackiya-calibrate-btn') as HTMLButtonElement | null;

        expect(saveBtn?.disabled).toBe(true);
        expect(copyBtn?.disabled).toBe(true);
        expect(calibrateBtn?.disabled).toBe(false);
        expect(calibrateBtn?.style.opacity).toBe('1');
    });

    it('dims calibrate only while capturing and restores opacity after', () => {
        const manager = new ButtonManager(
            async () => {},
            async () => {},
            async () => {},
        );
        manager.inject(document.body as any, '123');

        manager.setCalibrationState('capturing');
        const calibrateBtn = document.getElementById('blackiya-calibrate-btn') as HTMLButtonElement | null;
        expect(calibrateBtn?.disabled).toBe(true);
        expect(calibrateBtn?.style.opacity).toBe('0.85');

        manager.setCalibrationState('idle');
        expect(calibrateBtn?.disabled).toBe(false);
        expect(calibrateBtn?.style.opacity).toBe('1');
    });

    it('shows friendly calibration timestamp when provided in success state', () => {
        const manager = new ButtonManager(
            async () => {},
            async () => {},
            async () => {},
        );
        manager.inject(document.body as any, '123');

        manager.setCalibrationState('success', { timestampLabel: '5m ago' });
        const calibrateBtn = document.getElementById('blackiya-calibrate-btn') as HTMLButtonElement | null;

        expect(calibrateBtn?.textContent).toContain('Captured');
        expect(calibrateBtn?.textContent).toContain('5m ago');
    });
});
