import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { expect, test } from '@playwright/test';
import { resolveExtensionPath } from './extension-path';
import { closeExtensionContext, launchExtensionContext } from './extension-test-context';

const extension = resolveExtensionPath();

test.describe('blackiya smoke harness', () => {
    test.skip(!extension.valid, extension.reason ?? 'Unable to resolve extension path');

    const resolveExtensionWorker = async (context: Awaited<ReturnType<typeof launchExtensionContext>>['context']) => {
        return (
            context.serviceWorkers()[0] ??
            (await context.waitForEvent('serviceworker', {
                timeout: 10_000,
            }))
        );
    };

    test('loads extension popup shell in Chromium', async () => {
        const manifestPath = path.join(extension.extensionPath, 'manifest.json');
        const manifestRaw = await readFile(manifestPath, 'utf8');
        const manifest = JSON.parse(manifestRaw) as { background?: { service_worker?: string } };
        const serviceWorkerPath = manifest.background?.service_worker ?? null;
        expect(serviceWorkerPath).not.toBeNull();
        if (!serviceWorkerPath) {
            throw new Error('Expected background.service_worker in extension manifest');
        }

        const extensionContext = await launchExtensionContext(extension.extensionPath);
        try {
            const background = await resolveExtensionWorker(extensionContext.context);
            expect(background ?? null).not.toBeNull();
            const backgroundUrl = new URL(background.url());
            expect(backgroundUrl.protocol).toBe('chrome-extension:');
            expect(backgroundUrl.pathname).toBe(`/${serviceWorkerPath}`);
        } finally {
            await closeExtensionContext(extensionContext);
        }
    });

    test('renders popup controls and metadata from extension page', async () => {
        const extensionContext = await launchExtensionContext(extension.extensionPath);
        try {
            const background = await resolveExtensionWorker(extensionContext.context);
            const extensionId = new URL(background.url()).host;
            expect(extensionId.length).toBeGreaterThan(0);

            const page = await extensionContext.context.newPage();
            await page.goto(`chrome-extension://${extensionId}/popup.html`);

            await expect(page.locator('text=Blackiya Settings')).toBeVisible();
            await expect(page.locator('#logLevel')).toBeVisible();
            await expect(page.locator('#exportFormat')).toBeVisible();
            await expect(page.locator('#bulkExportLimit')).toBeVisible();
            await expect(page.locator('text=Export Chats')).toBeVisible();
            await expect(page.locator('text=Export Full Logs (JSON)')).toBeVisible();
            await expect(page.locator('text=Export Debug Report (TXT)')).toBeVisible();
            await expect(page.locator('#bulkExportDelayMs')).toHaveCount(0);
            await expect(page.locator('#bulkExportTimeoutMs')).toHaveCount(0);
            await expect(page.locator('#streamProbeVisible')).toHaveCount(0);
        } finally {
            await closeExtensionContext(extensionContext);
        }
    });
});
