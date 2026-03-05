import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { type BrowserContext, chromium } from '@playwright/test';

type ExtensionTestContext = {
    context: BrowserContext;
    userDataDir: string;
};

export const launchExtensionContext = async (extensionPath: string): Promise<ExtensionTestContext> => {
    const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'blackiya-e2e-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
        headless: true,
        args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    });
    return { context, userDataDir };
};

export const closeExtensionContext = async ({ context, userDataDir }: ExtensionTestContext) => {
    await context.close();
    await rm(userDataDir, { recursive: true, force: true });
};
