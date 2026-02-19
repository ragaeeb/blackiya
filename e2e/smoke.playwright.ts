import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { chromium, expect, test } from '@playwright/test';

const extensionPath = process.env.BLACKIYA_EXTENSION_PATH;

test.describe('blackiya smoke harness', () => {
    test.skip(!extensionPath, 'Set BLACKIYA_EXTENSION_PATH to run extension smoke tests');

    test('loads extension popup shell in Chromium', async () => {
        const manifestPath = path.join(extensionPath!, 'manifest.json');
        const manifestRaw = await readFile(manifestPath, 'utf8');
        const manifest = JSON.parse(manifestRaw) as { background?: { service_worker?: string } };
        const serviceWorkerPath = manifest.background?.service_worker ?? null;
        expect(serviceWorkerPath).not.toBeNull();
        if (!serviceWorkerPath) {
            throw new Error('Expected background.service_worker in extension manifest');
        }

        const context = await chromium.launchPersistentContext('', {
            headless: true,
            args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
        });
        try {
            const background =
                context.serviceWorkers()[0] ??
                (await context.waitForEvent('serviceworker', {
                    timeout: 10_000,
                }));
            expect(background ?? null).not.toBeNull();
            const backgroundUrl = new URL(background.url());
            expect(backgroundUrl.protocol).toBe('chrome-extension:');
            expect(backgroundUrl.pathname).toBe(`/${serviceWorkerPath}`);
        } finally {
            await context.close();
        }
    });
});
