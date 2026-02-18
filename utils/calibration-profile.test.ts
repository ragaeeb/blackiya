import { describe, expect, it, mock } from 'bun:test';

let stored: Record<string, unknown> = {};

mock.module('wxt/browser', () => ({
    browser: {
        storage: {
            local: {
                get: async (key: string) => ({ [key]: stored[key] }),
                set: async (value: Record<string, unknown>) => {
                    stored = {
                        ...stored,
                        ...value,
                    };
                },
            },
        },
    },
}));

import {
    buildCalibrationProfileFromStep,
    buildDefaultCalibrationProfile,
    type CalibrationStep,
    loadCalibrationProfileV2,
    loadCalibrationProfileV2IfPresent,
    saveCalibrationProfileV2,
    stepFromStrategy,
    strategyFromStep,
    validateCalibrationProfileV2,
} from '@/utils/calibration-profile';
import { STORAGE_KEYS } from '@/utils/settings';

describe('calibration-profile', () => {
    it('returns conservative defaults for invalid profile input', () => {
        const profile = validateCalibrationProfileV2(null, 'ChatGPT');
        expect(profile.platform).toBe('ChatGPT');
        expect(profile.schemaVersion).toBe(2);
        expect(profile.strategy).toBe('conservative');
    });

    it('normalizes and clamps malformed profile values', () => {
        const profile = validateCalibrationProfileV2(
            {
                strategy: 'balanced',
                timingsMs: {
                    passiveWait: -100,
                    domQuietWindow: 999999,
                    maxStabilizationWait: 100,
                },
                retry: {
                    maxAttempts: 99,
                    backoffMs: [100, 'bad', -1, 200] as unknown[],
                    hardTimeoutMs: 999999,
                },
                disabledSources: ['dom_hint', 'not-real'],
            },
            'Gemini',
        );

        expect(profile.strategy).toBe('balanced');
        expect(profile.timingsMs.passiveWait).toBeGreaterThanOrEqual(100);
        expect(profile.retry.maxAttempts).toBeLessThanOrEqual(20);
        expect(profile.disabledSources).toEqual(['dom_hint']);
    });

    it('preserves strategy disabledSources defaults when disabledSources is missing', () => {
        const aggressive = validateCalibrationProfileV2({ strategy: 'aggressive' }, 'Gemini');
        const balanced = validateCalibrationProfileV2({ strategy: 'balanced' }, 'Gemini');
        const conservative = validateCalibrationProfileV2({ strategy: 'conservative' }, 'Gemini');

        expect(aggressive.disabledSources).toEqual(['snapshot_fallback']);
        expect(balanced.disabledSources).toEqual(['dom_hint', 'snapshot_fallback']);
        expect(conservative.disabledSources).toEqual(['dom_hint', 'snapshot_fallback']);
    });

    it('preserves strategy disabledSources defaults when disabledSources is invalid', () => {
        const aggressive = validateCalibrationProfileV2(
            { strategy: 'aggressive', disabledSources: 'bad' as unknown },
            'Gemini',
        );
        const balanced = validateCalibrationProfileV2(
            { strategy: 'balanced', disabledSources: 123 as unknown },
            'Gemini',
        );

        expect(aggressive.disabledSources).toEqual(['snapshot_fallback']);
        expect(balanced.disabledSources).toEqual(['dom_hint', 'snapshot_fallback']);
    });

    it('normalizes valid disabledSources list by filtering and deduping', () => {
        const profile = validateCalibrationProfileV2(
            {
                strategy: 'aggressive',
                disabledSources: ['dom_hint', 'dom_hint', 'snapshot_fallback', 'invalid'],
            },
            'Gemini',
        );

        expect(profile.disabledSources).toEqual(['dom_hint', 'snapshot_fallback']);
    });

    it('loads and saves profile via storage', async () => {
        stored = {};
        const profile = buildDefaultCalibrationProfile('Grok', 'aggressive');
        await saveCalibrationProfileV2(profile);

        const store = stored[STORAGE_KEYS.CALIBRATION_PROFILES] as Record<string, unknown>;
        expect(store.Grok).toBeDefined();

        const loaded = await loadCalibrationProfileV2('Grok');
        expect(loaded.platform).toBe('Grok');
        expect(loaded.schemaVersion).toBe(2);
    });

    it('returns null when profile is not present', async () => {
        stored = {};
        const loaded = await loadCalibrationProfileV2IfPresent('ChatGPT');
        expect(loaded).toBeNull();
    });

    it('preserves empty disabledSources array as-is (no fallback applied)', () => {
        const profile = validateCalibrationProfileV2({ strategy: 'aggressive', disabledSources: [] }, 'Gemini');
        expect(profile.disabledSources).toEqual([]);
    });

    it('falls back to strategy defaults when all disabledSources entries are invalid', () => {
        const profile = validateCalibrationProfileV2(
            { strategy: 'aggressive', disabledSources: ['not-real', 'also-not-real'] },
            'Gemini',
        );
        expect(profile.disabledSources).toEqual(['snapshot_fallback']);
    });
});

describe('calibration step/strategy mapping', () => {
    it('should map steps to strategies correctly', () => {
        expect(strategyFromStep('passive-wait')).toBe('aggressive');
        expect(strategyFromStep('endpoint-retry')).toBe('balanced');
        expect(strategyFromStep('queue-flush')).toBe('conservative');
        expect(strategyFromStep('page-snapshot')).toBe('conservative');
    });

    it('should map strategies to steps correctly', () => {
        expect(stepFromStrategy('aggressive')).toBe('passive-wait');
        expect(stepFromStrategy('balanced')).toBe('endpoint-retry');
        expect(stepFromStrategy('conservative')).toBe('queue-flush');
    });

    it('should round-trip strategy→step→strategy', () => {
        for (const strategy of ['aggressive', 'balanced', 'conservative'] as const) {
            expect(strategyFromStep(stepFromStrategy(strategy))).toBe(strategy);
        }
    });
});

describe('buildCalibrationProfileFromStep (manual-strict policy)', () => {
    it('should produce correct passive-wait/aggressive profile', () => {
        const profile = buildCalibrationProfileFromStep('ChatGPT', 'passive-wait');
        expect(profile.strategy).toBe('aggressive');
        expect(profile.platform).toBe('ChatGPT');
        expect(profile.schemaVersion).toBe(2);
        expect(profile.lastModifiedBy).toBe('manual');
        expect(profile.disabledSources).toEqual(['dom_hint', 'snapshot_fallback']);
        expect(profile.timingsMs).toEqual({ passiveWait: 900, domQuietWindow: 500, maxStabilizationWait: 12_000 });
        expect(profile.retry).toEqual({ maxAttempts: 3, backoffMs: [300, 800, 1300], hardTimeoutMs: 12_000 });
    });

    it('should produce correct endpoint-retry/balanced profile', () => {
        const profile = buildCalibrationProfileFromStep('Gemini', 'endpoint-retry');
        expect(profile.strategy).toBe('balanced');
        expect(profile.platform).toBe('Gemini');
        expect(profile.lastModifiedBy).toBe('manual');
        expect(profile.disabledSources).toEqual(['dom_hint', 'snapshot_fallback']);
        expect(profile.timingsMs).toEqual({ passiveWait: 1400, domQuietWindow: 800, maxStabilizationWait: 18_000 });
        expect(profile.retry).toEqual({ maxAttempts: 4, backoffMs: [400, 900, 1600, 2400], hardTimeoutMs: 20_000 });
    });

    it('should produce correct queue-flush/conservative profile', () => {
        const profile = buildCalibrationProfileFromStep('Grok', 'queue-flush');
        expect(profile.strategy).toBe('conservative');
        expect(profile.lastModifiedBy).toBe('manual');
        expect(profile.disabledSources).toEqual(['dom_hint', 'snapshot_fallback']);
        expect(profile.timingsMs).toEqual({ passiveWait: 2200, domQuietWindow: 800, maxStabilizationWait: 30_000 });
        expect(profile.retry).toEqual({
            maxAttempts: 6,
            backoffMs: [800, 1600, 2600, 3800, 5200, 7000],
            hardTimeoutMs: 30_000,
        });
    });

    it('should produce correct page-snapshot/conservative profile', () => {
        const profile = buildCalibrationProfileFromStep('Grok', 'page-snapshot');
        expect(profile.strategy).toBe('conservative');
        expect(profile.lastModifiedBy).toBe('manual');
        expect(profile.disabledSources).toEqual(['dom_hint', 'snapshot_fallback']);
    });

    it('should have intentionally different domQuietWindow from generic conservative defaults', () => {
        const manualStrict = buildCalibrationProfileFromStep('ChatGPT', 'queue-flush');
        const genericDefaults = buildDefaultCalibrationProfile('ChatGPT', 'conservative');
        // Manual-strict uses 800ms, generic uses 1200ms — this is intentional
        expect(manualStrict.timingsMs.domQuietWindow).toBe(800);
        expect(genericDefaults.timingsMs.domQuietWindow).toBe(1200);
    });

    it('should always set lastModifiedBy to manual regardless of step', () => {
        const steps: CalibrationStep[] = ['passive-wait', 'endpoint-retry', 'queue-flush', 'page-snapshot'];
        for (const step of steps) {
            expect(buildCalibrationProfileFromStep('Test', step).lastModifiedBy).toBe('manual');
        }
    });

    it('should always disable dom_hint and snapshot_fallback regardless of step', () => {
        const steps: CalibrationStep[] = ['passive-wait', 'endpoint-retry', 'queue-flush', 'page-snapshot'];
        for (const step of steps) {
            expect(buildCalibrationProfileFromStep('Test', step).disabledSources).toEqual([
                'dom_hint',
                'snapshot_fallback',
            ]);
        }
    });
});
