import { describe, expect, it, mock } from 'bun:test';
import {
    createStorageChangeListener,
    createVisibilityChangeHandler,
    getExportFormat,
    loadStreamDumpSetting,
    loadStreamProbeVisibilitySetting,
    scheduleButtonInjectionRetries,
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

        it('should return default when storage read throws', async () => {
            const { browser } = await import('wxt/browser');
            (browser.storage.local.get as ReturnType<typeof mock>).mockImplementationOnce(async () => {
                throw new Error('storage failure');
            });
            expect(await getExportFormat('common')).toBe('common');
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

    describe('loadStreamDumpSetting', () => {
        it('should call setStreamDumpEnabled(false) and emitStreamDumpConfig when storage read fails', async () => {
            const deps = {
                setStreamDumpEnabled: mock(() => {}),
                emitStreamDumpConfig: mock(() => {}),
            };
            const { browser } = await import('wxt/browser');
            (browser.storage.local.get as ReturnType<typeof mock>).mockImplementationOnce(async () => {
                throw new Error('storage read error');
            });

            await loadStreamDumpSetting(deps);

            expect(deps.setStreamDumpEnabled).toHaveBeenCalledWith(false);
            expect(deps.emitStreamDumpConfig).toHaveBeenCalled();
        });
    });

    describe('loadStreamProbeVisibilitySetting', () => {
        it('should load stream probe visibility from storage', async () => {
            const deps = {
                setStreamProbeVisible: mock(() => {}),
                getStreamProbeVisible: mock(() => true),
                removeStreamProbePanel: mock(() => {}),
            };
            const { browser } = await import('wxt/browser');
            (browser.storage.local.get as ReturnType<typeof mock>).mockImplementationOnce(async () => ({
                [STORAGE_KEYS.STREAM_PROBE_VISIBLE]: true,
            }));

            await loadStreamProbeVisibilitySetting(deps);

            expect(deps.setStreamProbeVisible).toHaveBeenCalledWith(true);
            expect(deps.removeStreamProbePanel).not.toHaveBeenCalled();
        });

        it('should remove the probe panel when visibility is false', async () => {
            const deps = {
                setStreamProbeVisible: mock(() => {}),
                getStreamProbeVisible: mock(() => false),
                removeStreamProbePanel: mock(() => {}),
            };
            const { browser } = await import('wxt/browser');
            (browser.storage.local.get as ReturnType<typeof mock>).mockImplementationOnce(async () => ({}));

            await loadStreamProbeVisibilitySetting(deps);

            expect(deps.removeStreamProbePanel).toHaveBeenCalled();
        });

        it('should call setStreamProbeVisible(false) and remove panel when storage read fails', async () => {
            const deps = {
                setStreamProbeVisible: mock(() => {}),
                getStreamProbeVisible: mock(() => false),
                removeStreamProbePanel: mock(() => {}),
            };
            const { browser } = await import('wxt/browser');
            (browser.storage.local.get as ReturnType<typeof mock>).mockImplementationOnce(async () => {
                throw new Error('storage error');
            });

            await loadStreamProbeVisibilitySetting(deps);

            expect(deps.setStreamProbeVisible).toHaveBeenCalledWith(false);
            expect(deps.removeStreamProbePanel).toHaveBeenCalled();
        });
    });

    describe('createStorageChangeListener - calibration profiles', () => {
        it('should call handleCalibrationProfilesChanged when CALIBRATION_PROFILES changes and adapter exists', () => {
            const deps = {
                setStreamDumpEnabled: mock(() => {}),
                emitStreamDumpConfig: mock(() => {}),
                setStreamProbeVisible: mock(() => {}),
                removeStreamProbePanel: mock(() => {}),
                setSfeEnabled: mock(() => {}),
                refreshButtonState: mock(() => {}),
                getCurrentConversationId: mock(() => null),
                hasAdapter: mock(() => true),
                handleCalibrationProfilesChanged: mock(() => {}),
            };

            const listener = createStorageChangeListener(deps);

            listener(
                {
                    [STORAGE_KEYS.CALIBRATION_PROFILES]: { newValue: {} as any, oldValue: undefined as any },
                },
                'local',
            );

            expect(deps.handleCalibrationProfilesChanged).toHaveBeenCalled();
        });

        it('should not call handleCalibrationProfilesChanged when adapter is absent', () => {
            const deps = {
                setStreamDumpEnabled: mock(() => {}),
                emitStreamDumpConfig: mock(() => {}),
                setStreamProbeVisible: mock(() => {}),
                removeStreamProbePanel: mock(() => {}),
                setSfeEnabled: mock(() => {}),
                refreshButtonState: mock(() => {}),
                getCurrentConversationId: mock(() => null),
                hasAdapter: mock(() => false),
                handleCalibrationProfilesChanged: mock(() => {}),
            };

            const listener = createStorageChangeListener(deps);
            listener(
                {
                    [STORAGE_KEYS.CALIBRATION_PROFILES]: { newValue: {} as any, oldValue: undefined as any },
                },
                'local',
            );

            expect(deps.handleCalibrationProfilesChanged).not.toHaveBeenCalled();
        });

        it('should not call removeStreamProbePanel when probe visibility is toggled to true', () => {
            const deps = {
                setStreamDumpEnabled: mock(() => {}),
                emitStreamDumpConfig: mock(() => {}),
                setStreamProbeVisible: mock(() => {}),
                removeStreamProbePanel: mock(() => {}),
                setSfeEnabled: mock(() => {}),
                refreshButtonState: mock(() => {}),
                getCurrentConversationId: mock(() => null),
                hasAdapter: mock(() => false),
                handleCalibrationProfilesChanged: mock(() => {}),
            };

            const listener = createStorageChangeListener(deps);
            listener(
                {
                    [STORAGE_KEYS.STREAM_PROBE_VISIBLE]: { newValue: true as any, oldValue: false as any },
                },
                'local',
            );

            expect(deps.setStreamProbeVisible).toHaveBeenCalledWith(true);
            expect(deps.removeStreamProbePanel).not.toHaveBeenCalled();
        });

        it('should treat SFE_ENABLED as true when newValue is not explicitly false', () => {
            const deps = {
                setStreamDumpEnabled: mock(() => {}),
                emitStreamDumpConfig: mock(() => {}),
                setStreamProbeVisible: mock(() => {}),
                removeStreamProbePanel: mock(() => {}),
                setSfeEnabled: mock(() => {}),
                refreshButtonState: mock(() => {}),
                getCurrentConversationId: mock(() => null),
                hasAdapter: mock(() => false),
                handleCalibrationProfilesChanged: mock(() => {}),
            };

            const listener = createStorageChangeListener(deps);
            listener(
                {
                    [STORAGE_KEYS.SFE_ENABLED]: { newValue: true as any, oldValue: false as any },
                },
                'local',
            );

            expect(deps.setSfeEnabled).toHaveBeenCalledWith(true);
        });
    });

    describe('createVisibilityChangeHandler', () => {
        const buildDeps = () => ({
            resolveConversationId: mock(() => null as string | null),
            getCurrentConversationId: mock(() => null as string | null),
            resolveReadinessDecision: mock(() => ({ mode: 'awaiting_stabilization' }) as any),
            resolveAttemptId: mock(() => 'attempt-1'),
            maybeRestartCanonicalRecoveryAfterTimeout: mock(() => {}),
            requestPageSnapshot: mock(() => Promise.resolve(null)),
            isConversationDataLike: mock(() => false) as any,
            ingestConversationData: mock(() => {}),
            getConversation: mock(() => undefined as any),
            evaluateReadinessForData: mock(() => ({ ready: false })),
            markCanonicalCaptureMeta: mock(() => {}),
            ingestSfeCanonicalSample: mock(() => {}),
            refreshButtonState: mock(() => {}),
            warmFetchConversationSnapshot: mock(() => Promise.resolve(true)),
        });

        const setDocumentHidden = (hidden: boolean) => {
            if (!(globalThis as any).document) {
                (globalThis as any).document = {};
            }
            Object.defineProperty(globalThis.document, 'hidden', { value: hidden, configurable: true });
        };

        it('should ignore if tab is hidden', () => {
            setDocumentHidden(true);
            const deps = buildDeps();
            createVisibilityChangeHandler(deps)();
            expect(deps.resolveConversationId).not.toHaveBeenCalled();
            setDocumentHidden(false);
        });

        it('should ignore if no conversationId is resolved', () => {
            setDocumentHidden(false);
            const deps = buildDeps();
            createVisibilityChangeHandler(deps)();
            expect(deps.maybeRestartCanonicalRecoveryAfterTimeout).not.toHaveBeenCalled();
        });

        it('should ignore if already canonical_ready', () => {
            setDocumentHidden(false);
            const deps = buildDeps();
            deps.resolveConversationId = mock(() => 'conv-1');
            deps.resolveReadinessDecision = mock(() => ({ mode: 'canonical_ready' }) as any);
            createVisibilityChangeHandler(deps)();
            expect(deps.maybeRestartCanonicalRecoveryAfterTimeout).not.toHaveBeenCalled();
        });

        it('should attempt recovery when tab becomes visible with a non-ready conversation', async () => {
            setDocumentHidden(false);
            const deps = buildDeps();
            deps.resolveConversationId = mock(() => 'conv-1');
            createVisibilityChangeHandler(deps)();
            // Allow async chains to settle
            await new Promise((r) => setTimeout(r, 0));
            expect(deps.maybeRestartCanonicalRecoveryAfterTimeout).toHaveBeenCalledWith('conv-1', 'attempt-1');
            expect(deps.requestPageSnapshot).toHaveBeenCalledWith('conv-1');
            expect(deps.warmFetchConversationSnapshot).toHaveBeenCalledWith('conv-1', 'force-save');
        });

        it('should ingest snapshot and mark canonical when snapshot is valid and ready', async () => {
            setDocumentHidden(false);
            const fakeData = { mapping: {}, title: 'T' } as any;
            const deps = buildDeps();
            deps.resolveConversationId = mock(() => 'conv-1');
            deps.requestPageSnapshot = mock(() => Promise.resolve(fakeData));
            deps.isConversationDataLike = mock(() => true) as any;
            deps.getConversation = mock(() => fakeData);
            deps.evaluateReadinessForData = mock(() => ({ ready: true }));

            createVisibilityChangeHandler(deps)();
            await new Promise((r) => setTimeout(r, 0));

            expect(deps.ingestConversationData).toHaveBeenCalledWith(fakeData, 'visibility-recovery-snapshot');
            expect(deps.markCanonicalCaptureMeta).toHaveBeenCalledWith('conv-1');
            expect(deps.ingestSfeCanonicalSample).toHaveBeenCalled();
            expect(deps.refreshButtonState).toHaveBeenCalled();
        });

        it('should not ingest when snapshot is not conversation-data-like', async () => {
            setDocumentHidden(false);
            const deps = buildDeps();
            deps.resolveConversationId = mock(() => 'conv-1');
            deps.requestPageSnapshot = mock(() => Promise.resolve({ notConversation: true } as unknown as null));
            deps.isConversationDataLike = mock(() => false) as any;

            createVisibilityChangeHandler(deps)();
            await new Promise((r) => setTimeout(r, 0));

            expect(deps.ingestConversationData).not.toHaveBeenCalled();
        });

        it('should skip markCanonical if cached conversation is absent', async () => {
            setDocumentHidden(false);
            const fakeData = { mapping: {}, title: 'T' } as any;
            const deps = buildDeps();
            deps.resolveConversationId = mock(() => 'conv-1');
            deps.requestPageSnapshot = mock(() => Promise.resolve(fakeData));
            deps.isConversationDataLike = mock(() => true) as any;
            deps.getConversation = mock(() => undefined);

            createVisibilityChangeHandler(deps)();
            await new Promise((r) => setTimeout(r, 0));

            expect(deps.ingestConversationData).toHaveBeenCalled();
            expect(deps.markCanonicalCaptureMeta).not.toHaveBeenCalled();
        });

        it('should not mark canonical if evaluateReadinessForData says not ready', async () => {
            setDocumentHidden(false);
            const fakeData = { mapping: {}, title: 'T' } as any;
            const deps = buildDeps();
            deps.resolveConversationId = mock(() => 'conv-1');
            deps.requestPageSnapshot = mock(() => Promise.resolve(fakeData));
            deps.isConversationDataLike = mock(() => true) as any;
            deps.getConversation = mock(() => fakeData);
            deps.evaluateReadinessForData = mock(() => ({ ready: false }));

            createVisibilityChangeHandler(deps)();
            await new Promise((r) => setTimeout(r, 0));

            expect(deps.markCanonicalCaptureMeta).not.toHaveBeenCalled();
            expect(deps.refreshButtonState).toHaveBeenCalled();
        });
    });

    describe('scheduleButtonInjectionRetries', () => {
        it('should not inject if buttonManager already exists at retry time', async () => {
            // scheduleButtonInjectionRetries uses window.setTimeout;
            // ensure window is available in this test environment.
            if (!(globalThis as any).window) {
                (globalThis as any).window = globalThis;
            }
            const injectSaveButton = mock(() => {});
            const buttonManagerExists = mock(() => true);
            const timers = scheduleButtonInjectionRetries(injectSaveButton, buttonManagerExists, [0]);
            await new Promise((r) => setTimeout(r, 10));
            expect(injectSaveButton).not.toHaveBeenCalled();
            for (const t of timers) {
                clearTimeout(t);
            }
        });

        it('should inject when buttonManager does not exist at retry time', async () => {
            if (!(globalThis as any).window) {
                (globalThis as any).window = globalThis;
            }
            const injectSaveButton = mock(() => {});
            const buttonManagerExists = mock(() => false);
            const timers = scheduleButtonInjectionRetries(injectSaveButton, buttonManagerExists, [0]);
            await new Promise((r) => setTimeout(r, 10));
            expect(injectSaveButton).toHaveBeenCalled();
            for (const t of timers) {
                clearTimeout(t);
            }
        });
    });
});
