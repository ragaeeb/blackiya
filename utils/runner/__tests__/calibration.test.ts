/**
 * Tests: Calibration button state display.
 *
 * Covers:
 *  - ✅ badge on no-conversation route when a calibration profile exists
 *  - ✅ badge on conversation route when a profile exists (but no data yet)
 *  - Friendly "X ago" timestamp shown in button tooltip when profile has updatedAt
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

let currentAdapterMock: any = createMockAdapter(document);
const browserMockState = {
    storageData: {} as Record<string, unknown>,
    sendMessage: async (_: unknown) => undefined as unknown,
};

mock.module('@/platforms/factory', () => ({
    getPlatformAdapter: () => currentAdapterMock,
    getPlatformAdapterByApiUrl: () => currentAdapterMock,
}));
mock.module('@/utils/download', () => ({ downloadAsJSON: () => {} }));
mock.module('@/utils/logger', () => buildLoggerMock(createLoggerCalls()));
mock.module('wxt/browser', () => buildBrowserMock(browserMockState));

import { runPlatform } from '@/utils/platform-runner';

// Shared calibration profile fixture

const makeCalibrationProfile = (platform: string, updatedAt?: string) => ({
    'userSettings.calibrationProfiles': {
        [platform]: {
            schemaVersion: 2,
            platform,
            strategy: 'aggressive',
            disabledSources: ['snapshot_fallback'],
            timingsMs: { passiveWait: 900, domQuietWindow: 500, maxStabilizationWait: 12_000 },
            retry: { maxAttempts: 3, backoffMs: [300, 800, 1300], hardTimeoutMs: 12_000 },
            updatedAt: updatedAt ?? '2026-02-14T00:00:00.000Z',
            lastModifiedBy: 'manual',
        },
    },
});

describe('Platform Runner – calibration state', () => {
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

    it('should show Captured (✅) calibration state on no-conversation route when profile exists', async () => {
        currentAdapterMock = { ...createMockAdapter(document), name: 'Gemini', extractConversationId: () => null };
        browserMockState.storageData = makeCalibrationProfile('Gemini');

        runPlatform();
        await new Promise((r) => setTimeout(r, 120));

        const btn = document.getElementById('blackiya-calibrate-btn');
        expect(btn).not.toBeNull();
        expect(btn?.textContent).toContain('✅');
    });

    it('should keep Captured (✅) calibration state on conversation route when profile exists but no data yet', async () => {
        currentAdapterMock = {
            ...createMockAdapter(document),
            name: 'Gemini',
            extractConversationId: () => 'gem-conv-1',
        };
        browserMockState.storageData = makeCalibrationProfile('Gemini');

        runPlatform();
        await new Promise((r) => setTimeout(r, 120));

        const btn = document.getElementById('blackiya-calibrate-btn');
        expect(btn).not.toBeNull();
        expect(btn?.textContent).toContain('✅');
    });

    it('should show friendly "X ago" timestamp in calibration button tooltip', async () => {
        const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1_000).toISOString();
        currentAdapterMock = {
            ...createMockAdapter(document),
            name: 'Gemini',
            extractConversationId: () => 'gem-conv-ts',
        };
        browserMockState.storageData = makeCalibrationProfile('Gemini', fiveMinutesAgo);

        runPlatform();
        await new Promise((r) => setTimeout(r, 120));

        const btn = document.getElementById('blackiya-calibrate-btn') as HTMLButtonElement | null;
        expect(btn).not.toBeNull();
        expect(btn?.textContent).toContain('✅');
        expect(btn?.title).toContain('ago');
    });
});
