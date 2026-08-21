import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { expect, test, type BrowserContext, type Route } from '@playwright/test';
import { HARNESS_AUTHORIZATION, HARNESS_CONVERSATION_ID } from '../harness/fixture';
import { resolveExtensionPath } from './extension-path';
import { closeExtensionContext, launchExtensionContext } from './extension-test-context';

const extension = resolveExtensionPath();
const relayExtensionPath = path.join(process.cwd(), 'harness', 'relay-extension');
const relayExtensionAvailable = existsSync(path.join(relayExtensionPath, 'manifest.json'));
const port = 5278 + (process.pid % 1000);
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

const providerRoute = async (route: Route) => {
    const requestUrl = new URL(route.request().url());
    if (
        requestUrl.pathname === '/harness.js' ||
        requestUrl.pathname.startsWith('/c/') ||
        requestUrl.pathname === '/backend-api/conversations' ||
        requestUrl.pathname.startsWith('/backend-api/conversation/') ||
        requestUrl.pathname === '/backend-api/f/conversation'
    ) {
        await proxyFixtureRequest(route);
        return;
    }
    await route.fulfill({ status: 404, body: 'Not found' });
};

const waitForRelayWorker = async (context: BrowserContext) => {
    const existing = context.serviceWorkers().find((worker) => worker.url().endsWith('/relay-background.js'));
    if (existing) {
        return existing;
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const worker = await context.waitForEvent('serviceworker', { timeout: 10_000 });
        if (worker.url().endsWith('/relay-background.js')) {
            return worker;
        }
    }
    throw new Error('The dev relay service worker did not start');
};

const readRelayEvents = async () => {
    const response = await fetch(`${fixtureBaseUrl}/events`);
    if (!response.ok) {
        return [] as Array<Record<string, unknown>>;
    }
    return (await response.json()) as Array<Record<string, unknown>>;
};

test.describe('blackiya authenticated-browser debug relay', () => {
    test.beforeAll(async () => {
        if (!extension.valid) {
            throw new Error(extension.reason ?? 'Unable to resolve extension path');
        }
        if (!relayExtensionAvailable) {
            throw new Error('The dev relay unpacked extension is missing');
        }
        harnessProcess = spawn('bun', ['run', 'scripts/browser-harness.ts', '--relay'], {
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

    test('forwards sanitized stream and Save JSON diagnostics only after explicit opt-in', async () => {
        const extensionContext = await launchExtensionContext(extension.extensionPath, [relayExtensionPath]);
        try {
            const relayWorker = await waitForRelayWorker(extensionContext.context);
            const relayId = new URL(relayWorker.url()).host;
            const settingsPage = await extensionContext.context.newPage();
            await settingsPage.goto(`chrome-extension://${relayId}/relay-enable.html`);
            await expect(settingsPage.locator('#relay-enabled')).not.toBeChecked();
            await settingsPage.locator('#relay-url').fill(`${fixtureBaseUrl}/events`);
            await settingsPage.locator('#relay-enabled').check();
            await settingsPage.locator('#save').click();
            await expect(settingsPage.locator('#status')).toHaveText('Relay enabled for this development profile.');

            const page = await extensionContext.context.newPage();
            await page.route(`${providerBaseUrl}/**`, providerRoute);
            const authSeedRequest = page.waitForRequest('**/backend-api/conversations*');
            await page.goto(`${providerBaseUrl}/c/${HARNESS_CONVERSATION_ID}?mode=success&relay=1`, {
                waitUntil: 'domcontentloaded',
            });
            expect((await authSeedRequest).headers().authorization).toBe(HARNESS_AUTHORIZATION);

            const extensionButton = page.locator('#blackiya-v3-export-chat-btn');
            await expect(extensionButton).toBeVisible();
            await page.getByRole('button', { name: 'Download review-ledger.json' }).click();
            await expect(extensionButton).toBeVisible();

            const downloadPromise = page.waitForEvent('download');
            await extensionButton.click();
            await downloadPromise;

            await expect
                .poll(
                    async () => {
                        const events = await readRelayEvents();
                        return events.some((event) => event.kind === 'stream-frame') &&
                            events.some((event) => event.kind === 'save-state' && event.state === 'success');
                    },
                    { timeout: 15_000 },
                )
                .toBe(true);

            const events = await readRelayEvents();
            const serialized = JSON.stringify(events);
            expect(serialized).not.toContain(HARNESS_AUTHORIZATION);
            expect(serialized).not.toContain('stream-debug');
            expect(events.some((event) => event.kind === 'stream-start')).toBe(true);
            expect(events.some((event) => event.kind === 'stream-end')).toBe(true);
            expect(events.some((event) => event.kind === 'save-click')).toBe(true);
            expect(events.some((event) => event.kind === 'save-state' && event.state === 'success')).toBe(true);
            expect(events.every((event) => typeof event.path !== 'string' || !/[?#]/.test(event.path))).toBe(true);
            expect(events.every((event) => !('headers' in event) && !('body' in event))).toBe(true);
        } finally {
            await closeExtensionContext(extensionContext);
        }
    });
});
