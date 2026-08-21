import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';

import { expect, test, type Route } from '@playwright/test';
import { HARNESS_AUTHORIZATION, HARNESS_CONVERSATION_ID } from '../harness/fixture';
import { resolveExtensionPath } from './extension-path';
import { closeExtensionContext, launchExtensionContext } from './extension-test-context';

const extension = resolveExtensionPath();
const port = 5178 + (process.pid % 1000);
const fixtureBaseUrl = `http://127.0.0.1:${port}`;
const providerBaseUrl = 'https://chatgpt.com';
let harnessProcess: ChildProcessWithoutNullStreams | undefined;

const waitForHarness = async (child: ChildProcessWithoutNullStreams) => {
    await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timed out waiting for the browser harness')), 15_000);
        const onOutput = (chunk: Buffer) => {
            if (chunk.toString().includes('Blackiya browser harness')) {
                clearTimeout(timeout);
                resolve();
            }
        };
        child.stdout.on('data', onOutput);
        child.stderr.on('data', (chunk: Buffer) => {
            if (chunk.toString().includes('error')) {
                clearTimeout(timeout);
                reject(new Error(chunk.toString()));
            }
        });
        child.once('error', (error) => {
            clearTimeout(timeout);
            reject(error);
        });
        child.once('exit', (code) => {
            if (code !== null && code !== 0) {
                clearTimeout(timeout);
                reject(new Error(`Browser harness exited before startup (${code})`));
            }
        });
    });
};

const proxyFixtureRequest = async (route: Route) => {
    const requestUrl = new URL(route.request().url());
    const fixtureUrl = `${fixtureBaseUrl}${requestUrl.pathname}${requestUrl.search}`;
    const authorization = route.request().headers().authorization;
    const response = await fetch(fixtureUrl, {
        method: route.request().method(),
        headers: authorization ? { authorization } : undefined,
    });
    await route.fulfill({
        status: response.status,
        headers: { 'content-type': response.headers.get('content-type') ?? 'application/json' },
        body: Buffer.from(await response.arrayBuffer()),
    });
};

const pageRoute = async (route: Route) => {
    const requestUrl = new URL(route.request().url());
    if (
        requestUrl.pathname === '/harness.js' ||
        requestUrl.pathname.startsWith('/c/') ||
        requestUrl.pathname === '/backend-api/conversations' ||
        requestUrl.pathname.startsWith('/backend-api/conversation/')
    ) {
        await proxyFixtureRequest(route);
        return;
    }
    await route.fulfill({ status: 404, body: 'Not found' });
};

test.describe('blackiya extension boundary harness', () => {
    test.skip(!extension.valid, extension.reason ?? 'Unable to resolve extension path');

    test.beforeAll(async () => {
        harnessProcess = spawn('bun', ['run', 'scripts/browser-harness.ts'], {
            cwd: process.cwd(),
            env: { ...process.env, BLACKIYA_HARNESS_PORT: String(port) },
            stdio: 'pipe',
        });
        await waitForHarness(harnessProcess);
    });

    test.afterAll(() => {
        harnessProcess?.kill('SIGTERM');
        harnessProcess = undefined;
    });

    test('keeps the real Save JSON control through artifact replacement and saves with captured auth', async () => {
        const extensionContext = await launchExtensionContext(extension.extensionPath);
        try {
            const page = await extensionContext.context.newPage();
            await page.route(`${providerBaseUrl}/**`, pageRoute);
            const authSeedRequest = page.waitForRequest('**/backend-api/conversations*');

            await page.goto(`${providerBaseUrl}/c/${HARNESS_CONVERSATION_ID}?mode=success`, {
                waitUntil: 'domcontentloaded',
            });

            expect((await authSeedRequest).headers().authorization).toBe(HARNESS_AUTHORIZATION);
            const extensionButton = page.locator('#blackiya-v3-export-chat-btn');
            await expect(extensionButton).toBeVisible();

            await page.getByRole('button', { name: 'Download review-ledger.json' }).click();
            await expect(page.locator('#harness-artifact-preview')).toBeVisible();
            await expect(extensionButton).toBeVisible();
            await expect(page.locator('[data-testid="harness-log"]')).toContainText(
                'Save JSON remained connected.',
            );

            const downloadPromise = page.waitForEvent('download');
            await extensionButton.click();
            const download = await downloadPromise;
            expect(download.suggestedFilename()).toMatch(/\.json$/);
            const downloadPath = await download.path();
            expect(downloadPath).not.toBeNull();
            if (downloadPath) {
                expect((await readFile(downloadPath)).toString()).toContain(
                    `"conversation_id": "${HARNESS_CONVERSATION_ID}"`,
                );
            }
            await expect(extensionButton).toHaveText('✓ Saved');
        } finally {
            await closeExtensionContext(extensionContext);
        }
    });
});
