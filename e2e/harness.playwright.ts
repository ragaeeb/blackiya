import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';

import { expect, test } from '@playwright/test';
import { HARNESS_AUTHORIZATION, HARNESS_CONVERSATION_ID } from '../harness/fixture';

const port = 4178 + (process.pid % 1000);
const baseUrl = `http://127.0.0.1:${port}`;
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

test('requires the deterministic authorization header for provider fixtures', async () => {
    const unauthenticated = await fetch(`${baseUrl}/backend-api/conversation/${HARNESS_CONVERSATION_ID}`);
    expect(unauthenticated.status).toBe(401);
    const authenticated = await fetch(`${baseUrl}/backend-api/conversation/${HARNESS_CONVERSATION_ID}`, {
        headers: { authorization: HARNESS_AUTHORIZATION },
    });
    expect(authenticated.status).toBe(200);
});

test('saves the finished harness conversation through the v3 single-export path', async ({ page }) => {
    await page.goto(`${baseUrl}/c/${HARNESS_CONVERSATION_ID}?mode=success`);

    await expect(page.getByRole('button', { name: 'Save JSON' })).toBeVisible();
    await page.getByRole('button', { name: 'Download review-ledger.json' }).click();
    await expect(page.locator('#harness-artifact-preview')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save JSON' })).toBeVisible();
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Save JSON' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.json$/);
    await expect(page.locator('[data-testid="harness-status"]')).toHaveText('Saved terminal conversation');
    await expect(page.locator('[data-testid="harness-download-count"]')).toHaveText('1');
    const downloadPath = await download.path();
    expect(downloadPath).not.toBeNull();
    if (!downloadPath) {
        return;
    }
    expect((await readFile(downloadPath)).toString()).toContain(`"conversation_id": "${HARNESS_CONVERSATION_ID}"`);
});

test('fails without a download when the harness response is not terminal', async ({ page }) => {
    await page.goto(`${baseUrl}/c/${HARNESS_CONVERSATION_ID}?mode=not-terminal`);

    await page.getByRole('button', { name: 'Save JSON' }).click();
    await expect(page.locator('[data-testid="harness-status"]')).toHaveText('Failed: not_terminal');
    await expect(page.locator('[data-testid="harness-download-count"]')).toHaveText('0');
});

test('saves a finished multimodal harness conversation', async ({ page }) => {
    await page.goto(`${baseUrl}/c/${HARNESS_CONVERSATION_ID}?mode=multimodal`);

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Save JSON' }).click();
    const download = await downloadPromise;
    await expect(page.locator('[data-testid="harness-status"]')).toHaveText('Saved terminal conversation');
    await expect(page.locator('[data-testid="harness-download-count"]')).toHaveText('1');
    const downloadPath = await download.path();
    expect(downloadPath).not.toBeNull();
    if (downloadPath) {
        expect((await readFile(downloadPath)).toString()).toContain('"content_type": "multimodal_text"');
    }
});
