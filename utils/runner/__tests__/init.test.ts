/**
 * Tests: Runner initialisation, teardown, and button injection.
 *
 * Covers:
 *  - Singleton teardown before a second runPlatform() call
 *  - SFE readiness-source attribute on the container
 *  - Button injection when a valid adapter is found
 *  - No button injection when no adapter matches
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { Window } from 'happy-dom';

const window = new Window();
const document = window.document;
(global as any).window = window;
(global as any).document = document;
(global as any).history = window.history;
(global as any).HTMLElement = window.HTMLElement;
(global as any).HTMLButtonElement = window.HTMLButtonElement;
(global as any).MutationObserver = window.MutationObserver;

import { buildBrowserMock, buildLoggerMock, createLoggerCalls, createMockAdapter } from './helpers';

// ---- mutable state (closed over by mock factories) -----------------------
let currentAdapterMock: any = createMockAdapter(document);
const browserMockState = {
    storageData: {} as Record<string, unknown>,
    sendMessage: async (_: unknown) => undefined as unknown,
};

// ---- module mocks (must precede subject import) ---------------------------
mock.module('@/platforms/factory', () => ({
    getPlatformAdapter: () => currentAdapterMock,
    getPlatformAdapterByApiUrl: () => currentAdapterMock,
}));
mock.module('@/utils/download', () => ({ downloadAsJSON: () => {} }));
mock.module('@/utils/logger', () => buildLoggerMock(createLoggerCalls()));
mock.module('wxt/browser', () => buildBrowserMock(browserMockState));

import { runPlatform } from '@/utils/platform-runner';

describe('Platform Runner – initialisation', () => {
    const countById = (id: string): number =>
        Array.from(document.getElementsByTagName('*')).filter((node) => node.id === id).length;

    beforeEach(() => {
        window.dispatchEvent(new (window as any).Event('beforeunload'));
        document.body.innerHTML = '';
        currentAdapterMock = createMockAdapter(document);
        browserMockState.storageData = {};
        browserMockState.sendMessage = async () => undefined;
        delete (window as any).location;
        (window as any).location = { href: 'https://test.com/c/123', origin: 'https://test.com' };
        (global as any).alert = () => {};
        (global as any).confirm = () => true;
        window.localStorage.clear();
        (globalThis as any).__BLACKIYA_CAPTURE_QUEUE__ = [];
        (globalThis as any).__BLACKIYA_LOG_QUEUE__ = [];
    });

    afterEach(() => {
        window.dispatchEvent(new (window as any).Event('beforeunload'));
    });

    it('should tear down previous runner instance before starting a new one', async () => {
        runPlatform();
        await new Promise((r) => setTimeout(r, 80));
        runPlatform();
        await new Promise((r) => setTimeout(r, 80));

        expect(countById('blackiya-button-container')).toBe(1);
        expect(countById('blackiya-save-btn')).toBe(1);
        expect(countById('blackiya-calibrate-btn')).toBe(1);
    });

    it('should keep SFE readiness source enabled', async () => {
        runPlatform();
        await new Promise((r) => setTimeout(r, 80));
        expect(document.getElementById('blackiya-button-container')?.getAttribute('data-readiness-source')).toBe('sfe');
    });

    it('should inject save button when valid adapter and ID found', async () => {
        runPlatform();
        await new Promise((r) => setTimeout(r, 100));
        const saveBtn = document.getElementById('blackiya-save-btn');
        const copyBtn = document.getElementById('blackiya-copy-btn');
        expect(saveBtn).not.toBeNull();
        expect(copyBtn).toBeNull();
        expect(saveBtn?.textContent).toContain('💾');
    });

    it('should NOT inject button if no adapter matches', async () => {
        currentAdapterMock = null;
        runPlatform();
        await new Promise((r) => setTimeout(r, 100));
        expect(document.getElementById('blackiya-save-btn')).toBeNull();
    });
});
