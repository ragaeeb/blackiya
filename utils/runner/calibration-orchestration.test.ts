import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { LLMPlatform } from '@/platforms/types';
import * as calibrationProfile from '@/utils/calibration-profile';
import { buildLoggerMock, createLoggerCalls } from '@/utils/runner/__tests__/helpers';
import {
    type CalibrationOrchestrationDeps,
    ensureCalibrationPreferenceLoaded,
    handleCalibrationClick,
    isCalibrationCaptureSatisfied,
    loadCalibrationPreference,
    runCalibrationCapture,
    syncCalibrationButtonDisplay,
} from '@/utils/runner/calibration-orchestration';

const logCalls = createLoggerCalls();
mock.module('@/utils/logger', () => buildLoggerMock(logCalls));

mock.module('@/utils/calibration-profile', () => ({
    loadCalibrationProfileV2IfPresent: mock(() => Promise.resolve(null)),
    saveCalibrationProfileV2: mock(() => Promise.resolve()),
    stepFromStrategy: mock((s) => s),
    buildCalibrationProfileFromStep: mock((p, s) => ({ platform: p, strategy: s })),
}));

describe('calibration-orchestration', () => {
    let deps: CalibrationOrchestrationDeps;
    let mockAdapter: LLMPlatform;

    beforeEach(() => {
        logCalls.debug.length = 0;
        logCalls.info.length = 0;
        logCalls.warn.length = 0;
        logCalls.error.length = 0;

        // Clear mocks on the module we created
        (calibrationProfile.loadCalibrationProfileV2IfPresent as ReturnType<typeof mock>).mockClear();
        (calibrationProfile.saveCalibrationProfileV2 as ReturnType<typeof mock>).mockClear();
        (calibrationProfile.stepFromStrategy as ReturnType<typeof mock>).mockClear();

        (globalThis as any).window = {
            location: { href: 'https://chat.openai.com/c/123' },
        };

        mockAdapter = {
            name: 'ChatGPT',
            extractConversationId: mock(() => '123'),
        } as unknown as LLMPlatform;

        let rememberedStep: any = null;
        let preferenceLoading: Promise<void> | null = null;
        let calibrationState: any = 'idle';

        deps = {
            getAdapter: mock(() => mockAdapter),
            getCalibrationState: mock(() => calibrationState),
            setCalibrationState: mock((s) => {
                calibrationState = s;
            }),
            getRememberedPreferredStep: mock(() => rememberedStep),
            setRememberedPreferredStep: mock((s) => {
                rememberedStep = s;
            }),
            getRememberedCalibrationUpdatedAt: mock(() => null),
            setRememberedCalibrationUpdatedAt: mock(() => {}),
            isCalibrationPreferenceLoaded: mock(() => false),
            setCalibrationPreferenceLoaded: mock(() => {}),
            getCalibrationPreferenceLoading: mock(() => preferenceLoading),
            setCalibrationPreferenceLoading: mock((p) => {
                preferenceLoading = p;
            }),
            runCalibrationStep: mock(() => Promise.resolve(false)),
            isConversationReadyForActions: mock(() => false),
            hasConversationData: mock(() => false),
            refreshButtonState: mock(() => {}),
            buttonManagerExists: mock(() => true),
            buttonManagerSetCalibrationState: mock(() => {}),
            syncRunnerStateCalibration: mock(() => {}),
        };
    });

    describe('loadCalibrationPreference', () => {
        it('should load profile and set preference flags', async () => {
            (calibrationProfile.loadCalibrationProfileV2IfPresent as ReturnType<typeof mock>).mockImplementation(() =>
                Promise.resolve({ strategy: 'passive-wait', updatedAt: '2022-01-01' }),
            );
            (calibrationProfile.stepFromStrategy as ReturnType<typeof mock>).mockImplementation((s) => s);

            await loadCalibrationPreference('ChatGPT', deps);

            expect(calibrationProfile.loadCalibrationProfileV2IfPresent).toHaveBeenCalledWith('ChatGPT');
            expect(deps.setRememberedPreferredStep).toHaveBeenCalledWith('passive-wait');
            expect(deps.setRememberedCalibrationUpdatedAt).toHaveBeenCalledWith('2022-01-01');
            expect(deps.setCalibrationPreferenceLoaded).toHaveBeenCalledWith(true);
            expect(deps.buttonManagerSetCalibrationState).toHaveBeenCalled();
        });

        it('should handle no profile safely', async () => {
            (calibrationProfile.loadCalibrationProfileV2IfPresent as ReturnType<typeof mock>).mockImplementation(() =>
                Promise.resolve(null),
            );

            await loadCalibrationPreference('ChatGPT', deps);

            expect(deps.setRememberedPreferredStep).toHaveBeenCalledWith(null);
            expect(deps.setRememberedCalibrationUpdatedAt).toHaveBeenCalledWith(null);
            expect(deps.setCalibrationPreferenceLoaded).toHaveBeenCalledWith(true);
        });

        it('should handle load error safely', async () => {
            (calibrationProfile.loadCalibrationProfileV2IfPresent as ReturnType<typeof mock>).mockImplementation(() =>
                Promise.reject(new Error('Test error')),
            );

            await loadCalibrationPreference('ChatGPT', deps);

            expect(logCalls.warn).toHaveLength(1);
            expect(deps.setCalibrationPreferenceLoaded).toHaveBeenCalledWith(true);
        });
    });

    describe('ensureCalibrationPreferenceLoaded', () => {
        it('should return resolved promise if already loaded', async () => {
            deps.isCalibrationPreferenceLoaded = () => true;
            await ensureCalibrationPreferenceLoaded('ChatGPT', deps);
            expect(calibrationProfile.loadCalibrationProfileV2IfPresent).not.toHaveBeenCalled();
        });

        it('should return existing promise if currently loading', async () => {
            const existing = Promise.resolve();
            deps.getCalibrationPreferenceLoading = () => existing;
            const result = ensureCalibrationPreferenceLoaded('ChatGPT', deps);
            expect(result).toBe(existing);
            await result;
        });

        it('should start loading process and return promise', async () => {
            const p = ensureCalibrationPreferenceLoaded('ChatGPT', deps);
            expect(deps.setCalibrationPreferenceLoading).toHaveBeenCalled();
            await p;
            expect(calibrationProfile.loadCalibrationProfileV2IfPresent).toHaveBeenCalledWith('ChatGPT');
        });
    });

    describe('syncCalibrationButtonDisplay', () => {
        it('should not update if button does not exist', () => {
            deps.buttonManagerExists = () => false;
            syncCalibrationButtonDisplay(deps);
            expect(deps.buttonManagerSetCalibrationState).not.toHaveBeenCalled();
        });

        it('should set appropriate status based on remember state', () => {
            deps.getCalibrationState = () => 'success';
            deps.getRememberedPreferredStep = () => 'queue-flush';
            syncCalibrationButtonDisplay(deps);
            expect(deps.buttonManagerSetCalibrationState).toHaveBeenCalled();
        });
    });

    describe('isCalibrationCaptureSatisfied', () => {
        it('should check if ready for action when auto mode', () => {
            deps.isConversationReadyForActions = () => true;
            expect(isCalibrationCaptureSatisfied('123', 'auto', deps)).toBeTrue();
        });

        it('should check if has data when manual mode', () => {
            deps.hasConversationData = () => true;
            expect(isCalibrationCaptureSatisfied('123', 'manual', deps)).toBeTrue();
        });
    });

    describe('runCalibrationCapture', () => {
        it('should not run if already capturing', async () => {
            deps.setCalibrationState('capturing');
            await runCalibrationCapture('manual', '123', deps);
            expect(deps.runCalibrationStep).not.toHaveBeenCalled();
        });

        it('should mark error if conversation ID is missing', async () => {
            mockAdapter.extractConversationId = () => null;
            await runCalibrationCapture('manual', undefined, deps);
            expect(deps.setCalibrationState).toHaveBeenCalledWith('error');
            expect(logCalls.warn).toHaveLength(1);
        });

        it('should execute steps and mark success if one succeeds (manual)', async () => {
            let _resolveRun: (res: boolean) => void;
            deps.runCalibrationStep = mock(() => Promise.resolve(true)); // immediate success

            await runCalibrationCapture('manual', '123', deps);

            expect(deps.setCalibrationState).toHaveBeenCalledWith('success');
            expect(deps.refreshButtonState).toHaveBeenCalledWith('123');
            expect(calibrationProfile.saveCalibrationProfileV2).toHaveBeenCalled();
        });

        it('should execute steps and mark success if one succeeds (auto)', async () => {
            deps.runCalibrationStep = mock(() => Promise.resolve(true));

            await runCalibrationCapture('auto', '123', deps);

            expect(deps.setCalibrationState).toHaveBeenCalledWith('success');
            expect(deps.refreshButtonState).toHaveBeenCalledWith('123');
            expect(calibrationProfile.saveCalibrationProfileV2).not.toHaveBeenCalled(); // Should not persist on auto
        });

        it('should try multiple steps and mark failure if all fails (manual)', async () => {
            deps.runCalibrationStep = mock(() => Promise.resolve(false));

            await runCalibrationCapture('manual', '123', deps);

            expect(deps.setCalibrationState).toHaveBeenCalledWith('error');
            expect(deps.refreshButtonState).toHaveBeenCalledWith('123');
            expect(calibrationProfile.saveCalibrationProfileV2).not.toHaveBeenCalled();
            expect(logCalls.warn).toHaveLength(1);
        });

        it('should try multiple steps and mark failure if all fails (auto)', async () => {
            deps.runCalibrationStep = mock(() => Promise.resolve(false));

            await runCalibrationCapture('auto', '123', deps);

            expect(deps.setCalibrationState).toHaveBeenCalledWith('idle');
            expect(calibrationProfile.saveCalibrationProfileV2).not.toHaveBeenCalled();
            expect(logCalls.warn).toHaveLength(1);
        });
    });

    describe('handleCalibrationClick', () => {
        it('should abort if already capturing', async () => {
            deps.setCalibrationState('capturing');
            await handleCalibrationClick(deps);
            expect(deps.runCalibrationStep).not.toHaveBeenCalled();
        });

        it('should run capture if waiting', async () => {
            deps.setCalibrationState('waiting');
            deps.runCalibrationStep = mock(() => Promise.resolve(true));
            await handleCalibrationClick(deps);
            // Verify capture logic was initiated
            expect(logCalls.info).toContainEqual(
                expect.objectContaining({
                    message: expect.stringContaining('Calibration capture started'),
                }),
            );
        });

        it('should transition to waiting if idle or others', async () => {
            deps.setCalibrationState('idle');
            await handleCalibrationClick(deps);
            expect(deps.setCalibrationState).toHaveBeenCalledWith('waiting');
            expect(logCalls.info).toContainEqual(
                expect.objectContaining({
                    message: expect.stringContaining('Calibration armed'),
                }),
            );
        });
    });
});
