import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { buildLoggerMock, createLoggerCalls } from '@/utils/runner/__tests__/helpers';
import { handleNavigationChange, type NavigationDeps, switchConversation } from '@/utils/runner/navigation-handler';

const logCalls = createLoggerCalls();
mock.module('@/utils/logger', () => buildLoggerMock(logCalls));

mock.module('@/platforms/factory', () => ({
    getPlatformAdapter: mock(() => ({ name: 'ChatGPT', extractConversationId: () => 'new-id' })),
}));

describe('navigation-handler', () => {
    let deps: NavigationDeps;
    let originalSetTimeout: typeof setTimeout;

    beforeEach(() => {
        logCalls.debug.length = 0;
        logCalls.info.length = 0;
        logCalls.warn.length = 0;
        logCalls.error.length = 0;

        (globalThis as any).window = { location: { href: 'http://test' } };
        originalSetTimeout = globalThis.setTimeout;
        globalThis.setTimeout = mock((fn: any) => {
            fn();
            return 1;
        }) as any;

        deps = {
            getCurrentAdapter: mock(() => ({ name: 'ChatGPT', extractConversationId: () => 'new-id' }) as any),
            getCurrentConversationId: mock(() => 'old-id'),
            getLifecycleState: mock(() => 'completed' as any),
            isLifecycleActiveGeneration: mock(() => false),
            setCurrentConversation: mock(() => {}),
            setLifecycleState: mock(() => {}),
            updateAdapter: mock(() => {}),
            disposeInFlightAttempts: mock(() => {}),
            buttonManagerRemove: mock(() => {}),
            buttonManagerExists: mock(() => true),
            injectSaveButton: mock(() => {}),
            refreshButtonState: mock(() => {}),
            resetCalibrationPreference: mock(() => {}),
            ensureCalibrationPreferenceLoaded: mock(() => Promise.resolve()),
            warmFetch: mock(() => Promise.resolve(true)),
            scheduleAutoCapture: mock(() => {}),
        };
    });

    afterEach(() => {
        globalThis.setTimeout = originalSetTimeout;
    });

    describe('switchConversation', () => {
        it('should dispose in-flight attempts, reset UI and handle null id', () => {
            switchConversation(null, deps);

            expect(deps.disposeInFlightAttempts).toHaveBeenCalledWith(null);
            expect(deps.setCurrentConversation).toHaveBeenCalledWith(null);
            expect(deps.setLifecycleState).toHaveBeenCalledWith('idle');
            expect(deps.injectSaveButton).toHaveBeenCalled();
        });

        it('should handle new conversation properly', () => {
            switchConversation('new-id', deps);

            expect(deps.disposeInFlightAttempts).toHaveBeenCalledWith('new-id');
            expect(deps.buttonManagerRemove).toHaveBeenCalled();
            expect(deps.setCurrentConversation).toHaveBeenCalledWith('new-id');
            expect(deps.setLifecycleState).toHaveBeenCalledWith('idle', 'new-id');
            expect(deps.warmFetch).toHaveBeenCalledWith('new-id', 'conversation-switch');
            expect(deps.scheduleAutoCapture).toHaveBeenCalledWith('new-id', 'navigation');
            expect(deps.injectSaveButton).toHaveBeenCalled();
        });

        it('should preserve active lifecycle if navigating into first prompt', () => {
            deps.getCurrentConversationId = () => null;
            deps.isLifecycleActiveGeneration = () => true;
            deps.getLifecycleState = () => 'streaming';

            switchConversation('new-id', deps);

            expect(deps.disposeInFlightAttempts).not.toHaveBeenCalled();
            expect(deps.buttonManagerRemove).not.toHaveBeenCalled();
            expect(deps.setLifecycleState).toHaveBeenCalledWith('streaming', 'new-id');
        });

        it('should update adapter if changed', () => {
            deps.getCurrentAdapter = () => ({ name: 'OldAdapter' }) as any;

            switchConversation('new-id', deps);

            expect(deps.updateAdapter).toHaveBeenCalled();
            expect(deps.resetCalibrationPreference).toHaveBeenCalled();
            expect(deps.ensureCalibrationPreferenceLoaded).toHaveBeenCalledWith('ChatGPT');
        });
    });

    describe('handleNavigationChange', () => {
        it('should abort if no adapter', () => {
            deps.getCurrentAdapter = () => null;
            handleNavigationChange(deps);
            expect(deps.setCurrentConversation).not.toHaveBeenCalled();
        });

        it('should trigger switchConversation if conversation id changed', () => {
            deps.getCurrentConversationId = () => 'different-id';
            handleNavigationChange(deps);
            expect(deps.setCurrentConversation).toHaveBeenCalledWith('new-id'); // 'new-id' is from mocked extractConversationId
        });

        it('should refresh button if conversation did not change but adapter exists', () => {
            deps.getCurrentConversationId = () => 'new-id';
            handleNavigationChange(deps);
            expect(deps.refreshButtonState).toHaveBeenCalledWith('new-id');
        });

        it('should inject save button if conversation did not change but button is missing', () => {
            deps.getCurrentConversationId = () => 'new-id';
            deps.buttonManagerExists = () => false;
            handleNavigationChange(deps);
            expect(deps.injectSaveButton).toHaveBeenCalled();
        });
    });
});
