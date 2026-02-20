import { describe, expect, it, mock } from 'bun:test';
import {
    createStorageChangeListener,
    createVisibilityChangeHandler,
    getExportFormat,
    loadStreamDumpSetting,
    loadStreamProbeVisibilitySetting,
} from '@/utils/runner/runtime-settings';
import { STORAGE_KEYS } from '@/utils/settings';

mock.module('wxt/browser', () => ({
    browser: {
        storage: {
            local: {
                get: mock(async () => ({})),
            },
            onChanged: {
                addListener: mock(() => {}),
            },
        },
    },
}));

describe('runtime-settings', () => {
    describe('getExportFormat', () => {
        it('should return default if value is missing or invalid', async () => {
            const { browser } = await import('wxt/browser');
            (browser.storage.local.get as ReturnType<typeof mock>).mockImplementationOnce(async () => ({}));
            expect(await getExportFormat('common')).toBe('common');

            (browser.storage.local.get as ReturnType<typeof mock>).mockImplementationOnce(async () => ({
                [STORAGE_KEYS.EXPORT_FORMAT]: 'invalid',
            }));
            expect(await getExportFormat('original')).toBe('original');
        });

        it('should return value from storage if valid', async () => {
            const { browser } = await import('wxt/browser');
            (browser.storage.local.get as ReturnType<typeof mock>).mockImplementationOnce(async () => ({
                [STORAGE_KEYS.EXPORT_FORMAT]: 'original',
            }));
            expect(await getExportFormat('common')).toBe('original');

            (browser.storage.local.get as ReturnType<typeof mock>).mockImplementationOnce(async () => ({
                [STORAGE_KEYS.EXPORT_FORMAT]: 'common',
            }));
            expect(await getExportFormat('original')).toBe('common');
        });
    });

    describe('loadStreamDumpSetting', () => {
        it('should load config and emit', async () => {
            const deps = {
                setStreamDumpEnabled: mock(() => {}),
                emitStreamDumpConfig: mock(() => {}),
            };
            const { browser } = await import('wxt/browser');
            (browser.storage.local.get as ReturnType<typeof mock>).mockImplementationOnce(async () => ({
                [STORAGE_KEYS.DIAGNOSTICS_STREAM_DUMP_ENABLED]: true,
            }));

            await loadStreamDumpSetting(deps);

            expect(deps.setStreamDumpEnabled).toHaveBeenCalledWith(true);
            expect(deps.emitStreamDumpConfig).toHaveBeenCalled();
        });
    });

    describe('createStorageChangeListener', () => {
        it('should handle property changes for local storage', () => {
            const deps = {
                setStreamDumpEnabled: mock(() => {}),
                emitStreamDumpConfig: mock(() => {}),
                setStreamProbeVisible: mock(() => {}),
                removeStreamProbePanel: mock(() => {}),
                setSfeEnabled: mock(() => {}),
                refreshButtonState: mock(() => {}),
                getCurrentConversationId: mock(() => 'conv-1'),
                hasAdapter: mock(() => true),
                handleCalibrationProfilesChanged: mock(() => {}),
            };

            const listener = createStorageChangeListener(deps);

            // ignore non-local
            listener({}, 'sync');
            expect(deps.setStreamDumpEnabled).not.toHaveBeenCalled();

            listener(
                {
                    [STORAGE_KEYS.DIAGNOSTICS_STREAM_DUMP_ENABLED]: { newValue: true as any, oldValue: false as any },
                    [STORAGE_KEYS.STREAM_PROBE_VISIBLE]: { newValue: false as any, oldValue: true as any },
                    [STORAGE_KEYS.SFE_ENABLED]: { newValue: false as any, oldValue: true as any },
                },
                'local',
            );

            expect(deps.setStreamDumpEnabled).toHaveBeenCalledWith(true);
            expect(deps.emitStreamDumpConfig).toHaveBeenCalled();
            expect(deps.setStreamProbeVisible).toHaveBeenCalledWith(false);
            expect(deps.removeStreamProbePanel).toHaveBeenCalled();
            expect(deps.setSfeEnabled).toHaveBeenCalledWith(false);
            expect(deps.refreshButtonState).toHaveBeenCalledWith('conv-1');
        });
    });

    describe('createVisibilityChangeHandler', () => {
        it('should ignore if tab is hidden', () => {
            if (!(globalThis as any).document) {
                (globalThis as any).document = {};
            }
            const oldHidden = Object.getOwnPropertyDescriptor(globalThis.document, 'hidden');
            Object.defineProperty(globalThis.document, 'hidden', { value: true, configurable: true });

            const deps = {
                resolveConversationId: mock(() => null),
                getCurrentConversationId: mock(() => null),
                resolveReadinessDecision: mock(() => ({ mode: 'canonical_ready' }) as any),
                resolveAttemptId: mock(() => ''),
                maybeRestartCanonicalRecoveryAfterTimeout: mock(() => {}),
                requestPageSnapshot: mock(() => Promise.resolve(null)),
                isConversationDataLike: mock(() => false) as any,
                ingestConversationData: mock(() => {}),
                getConversation: mock(() => undefined),
                evaluateReadinessForData: mock(() => ({ ready: false })),
                markCanonicalCaptureMeta: mock(() => {}),
                ingestSfeCanonicalSample: mock(() => {}),
                refreshButtonState: mock(() => {}),
                warmFetchConversationSnapshot: mock(() => Promise.resolve(true)),
            };

            const handler = createVisibilityChangeHandler(deps);
            handler();

            expect(deps.resolveConversationId).not.toHaveBeenCalled();

            if (oldHidden) {
                Object.defineProperty(globalThis.document, 'hidden', oldHidden);
            }
        });
    });
});
