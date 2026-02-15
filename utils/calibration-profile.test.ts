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
    buildDefaultCalibrationProfile,
    loadCalibrationProfileV2,
    saveCalibrationProfileV2,
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
});
