import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { chromium, expect, test } from '@playwright/test';

const extensionPath = process.env.BLACKIYA_EXTENSION_PATH;

test.describe('blackiya smoke harness', () => {
    test.skip(!extensionPath, 'Set BLACKIYA_EXTENSION_PATH to run extension smoke tests');

    const launchContext = async () =>
        chromium.launchPersistentContext('', {
            headless: true,
            args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
        });

    const resolveExtensionWorker = async (context: Awaited<ReturnType<typeof launchContext>>) => {
        return (
            context.serviceWorkers()[0] ??
            (await context.waitForEvent('serviceworker', {
                timeout: 10_000,
            }))
        );
    };

    test('loads extension popup shell in Chromium', async () => {
        const manifestPath = path.join(extensionPath!, 'manifest.json');
        const manifestRaw = await readFile(manifestPath, 'utf8');
        const manifest = JSON.parse(manifestRaw) as { background?: { service_worker?: string } };
        const serviceWorkerPath = manifest.background?.service_worker ?? null;
        expect(serviceWorkerPath).not.toBeNull();
        if (!serviceWorkerPath) {
            throw new Error('Expected background.service_worker in extension manifest');
        }

        const context = await launchContext();
        try {
            const background = await resolveExtensionWorker(context);
            expect(background ?? null).not.toBeNull();
            const backgroundUrl = new URL(background.url());
            expect(backgroundUrl.protocol).toBe('chrome-extension:');
            expect(backgroundUrl.pathname).toBe(`/${serviceWorkerPath}`);
        } finally {
            await context.close();
        }
    });

    test('renders popup controls and metadata from extension page', async () => {
        const context = await launchContext();
        try {
            const background = await resolveExtensionWorker(context);
            const extensionId = new URL(background.url()).host;
            expect(extensionId.length).toBeGreaterThan(0);

            const page = await context.newPage();
            await page.goto(`chrome-extension://${extensionId}/popup.html`);

            await expect(page.locator('text=Blackiya Settings')).toBeVisible();
            await expect(page.locator('#logLevel')).toBeVisible();
            await expect(page.locator('#exportFormat')).toBeVisible();
            await expect(page.locator('#streamDumpEnabled')).toBeVisible();
            await expect(page.locator('#streamProbeVisible')).toBeVisible();
            await expect(page.locator('text=Export Full Logs (JSON)')).toBeVisible();
            await expect(page.locator('text=Export Debug Report (TXT)')).toBeVisible();
            await expect(page.locator('text=Export Stream Dump (JSON)')).toBeVisible();
        } finally {
            await context.close();
        }
    });
});
