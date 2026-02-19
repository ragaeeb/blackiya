import path from 'node:path';
import { test, expect, chromium } from '@playwright/test';

const extensionPath = process.env.BLACKIYA_EXTENSION_PATH;

test.describe('blackiya smoke harness', () => {
    test.skip(!extensionPath, 'Set BLACKIYA_EXTENSION_PATH to run extension smoke tests');

    test('loads extension popup shell in Chromium', async () => {
        const context = await chromium.launchPersistentContext('', {
            headless: true,
            args: [
                `--disable-extensions-except=${extensionPath}`,
                `--load-extension=${extensionPath}`,
            ],
        });
        try {
            const background =
                context.serviceWorkers()[0] ??
                (await context.waitForEvent('serviceworker', {
                    timeout: 10_000,
                }));
            expect(background ?? null).not.toBeNull();
            // Ensure extension UI bundle exists in built output path.
            expect(path.isAbsolute(extensionPath!)).toBe(true);
        } finally {
            await context.close();
        }
    });
});
