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

import { NavigationManager } from './navigation-manager';

function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('NavigationManager', () => {
    let windowInstance: Window;
    let documentInstance: Window['document'];

    beforeEach(() => {
        windowInstance = new Window();
        documentInstance = windowInstance.document;

        (globalThis as any).window = windowInstance as any;
        (globalThis as any).document = documentInstance;
        (globalThis as any).history = windowInstance.history;
        (globalThis as any).MutationObserver = windowInstance.MutationObserver;

        windowInstance.location.href = 'https://chatgpt.com/c/11111111-1111-1111-1111-111111111111';

        loggerSpies.info.mockClear();
        loggerSpies.warn.mockClear();
        loggerSpies.error.mockClear();
        loggerSpies.debug.mockClear();
    });

    it('does not notify on pure DOM mutations when URL is unchanged', async () => {
        let callCount = 0;
        const manager = new NavigationManager(() => {
            callCount += 1;
        });

        manager.start();

        const div = documentInstance.createElement('div');
        documentInstance.body.appendChild(div);
        await wait(350);

        expect(callCount).toBe(0);

        manager.stop();
    });

    it('notifies once when URL changes and ignores duplicate same-URL pushes', async () => {
        let callCount = 0;
        const manager = new NavigationManager(() => {
            callCount += 1;
        });

        manager.start();

        windowInstance.history.pushState({}, '', '/c/22222222-2222-2222-2222-222222222222');
        await wait(10);
        expect(callCount).toBe(1);

        windowInstance.history.pushState({}, '', '/c/22222222-2222-2222-2222-222222222222');
        await wait(10);
        expect(callCount).toBe(1);

        manager.stop();
    });

    it('removes listeners on stop', async () => {
        let callCount = 0;
        const manager = new NavigationManager(() => {
            callCount += 1;
        });

        manager.start();
        manager.stop();

        windowInstance.history.pushState({}, '', '/c/33333333-3333-3333-3333-333333333333');
        await wait(10);

        expect(callCount).toBe(0);
    });
});
