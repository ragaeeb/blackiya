import { browser } from 'wxt/browser';
import { STORAGE_KEYS } from '@/utils/settings';
import type { SignalSource } from '@/utils/sfe/types';

export type CalibrationStrategy = 'aggressive' | 'balanced' | 'conservative' | 'snapshot';

export type CalibrationProfileV2 = {
    schemaVersion: 2;
    platform: string;
    strategy: CalibrationStrategy;
    disabledSources: SignalSource[];
    timingsMs: {
        passiveWait: number;
        domQuietWindow: number;
        maxStabilizationWait: number;
    };
    retry: {
        maxAttempts: number;
        backoffMs: number[];
        hardTimeoutMs: number;
    };
    updatedAt: string;
    lastModifiedBy: 'manual' | 'auto';
};

export type CalibrationProfileV2Store = Record<string, CalibrationProfileV2>;

const ALLOWED_SOURCE_SET = new Set<SignalSource>([
    'network_stream',
    'completion_endpoint',
    'canonical_fetch',
    'dom_hint',
    'snapshot_fallback',
]);

const ALLOWED_STRATEGY_SET = new Set<CalibrationStrategy>(['aggressive', 'balanced', 'conservative', 'snapshot']);

const isRecord = (value: unknown): value is Record<string, unknown> => {
    return !!value && typeof value === 'object' && !Array.isArray(value);
};

const clampNumber = (value: unknown, fallback: number, min: number, max: number): number => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return fallback;
    }
    return Math.max(min, Math.min(max, value));
};

const normalizeSignalSources = (value: unknown, fallback: SignalSource[]): SignalSource[] => {
    if (!Array.isArray(value)) {
        return [...fallback];
    }
    const normalized = value.filter(
        (source): source is SignalSource =>
            typeof source === 'string' && ALLOWED_SOURCE_SET.has(source as SignalSource),
    );
    const deduped = Array.from(new Set(normalized));
    if (value.length > 0 && deduped.length === 0) {
        return [...fallback];
    }
    return deduped;
};

const strategyDefaults = (strategy: CalibrationStrategy): CalibrationProfileV2 => {
    if (strategy === 'aggressive') {
        return {
            schemaVersion: 2,
            platform: 'Unknown',
            strategy,
            disabledSources: ['snapshot_fallback'],
            timingsMs: {
                passiveWait: 900,
                domQuietWindow: 500,
                maxStabilizationWait: 12_000,
            },
            retry: {
                maxAttempts: 3,
                backoffMs: [300, 800, 1300],
                hardTimeoutMs: 12_000,
            },
            updatedAt: new Date(0).toISOString(),
            lastModifiedBy: 'manual',
        };
    }

    if (strategy === 'balanced') {
        return {
            schemaVersion: 2,
            platform: 'Unknown',
            strategy,
            disabledSources: ['dom_hint', 'snapshot_fallback'],
            timingsMs: {
                passiveWait: 1400,
                domQuietWindow: 800,
                maxStabilizationWait: 18_000,
            },
            retry: {
                maxAttempts: 4,
                backoffMs: [400, 900, 1600, 2400],
                hardTimeoutMs: 20_000,
            },
            updatedAt: new Date(0).toISOString(),
            lastModifiedBy: 'manual',
        };
    }

    return {
        schemaVersion: 2,
        platform: 'Unknown',
        strategy,
        disabledSources: ['dom_hint', 'snapshot_fallback'],
        timingsMs: {
            passiveWait: 2200,
            domQuietWindow: 1200,
            maxStabilizationWait: 30_000,
        },
        retry: {
            maxAttempts: 6,
            backoffMs: [800, 1600, 2600, 3800, 5200, 7000],
            hardTimeoutMs: 30_000,
        },
        updatedAt: new Date(0).toISOString(),
        lastModifiedBy: 'manual',
    };
};

export const buildDefaultCalibrationProfile = (
    platform: string,
    strategy: CalibrationStrategy = 'conservative',
): CalibrationProfileV2 => {
    const defaults = strategyDefaults(strategy);
    return {
        ...defaults,
        platform,
        updatedAt: new Date().toISOString(),
    };
};

export type CalibrationStep = 'queue-flush' | 'passive-wait' | 'endpoint-retry' | 'page-snapshot';

export const strategyFromStep = (step: CalibrationStep): CalibrationStrategy => {
    if (step === 'passive-wait') {
        return 'aggressive';
    }
    if (step === 'endpoint-retry') {
        return 'balanced';
    }
    if (step === 'page-snapshot') {
        return 'snapshot';
    }
    return 'conservative';
};

export const stepFromStrategy = (strategy: CalibrationStrategy): CalibrationStep => {
    if (strategy === 'aggressive') {
        return 'passive-wait';
    }
    if (strategy === 'balanced') {
        return 'endpoint-retry';
    }
    if (strategy === 'snapshot') {
        return 'page-snapshot';
    }
    return 'queue-flush';
};

/**
 * Manual-strict policy timings. These intentionally differ from the generic
 * strategy defaults in conservative/domQuietWindow (800 vs 1200) to provide
 * tighter DOM quiet windows when the user has explicitly chosen/calibrated.
 */
const manualStrictTimings = (step: CalibrationStep): CalibrationProfileV2['timingsMs'] => {
    if (step === 'passive-wait') {
        return { passiveWait: 900, domQuietWindow: 500, maxStabilizationWait: 12_000 };
    }
    if (step === 'endpoint-retry') {
        return { passiveWait: 1400, domQuietWindow: 800, maxStabilizationWait: 18_000 };
    }
    return { passiveWait: 2200, domQuietWindow: 800, maxStabilizationWait: 30_000 };
};

const manualStrictRetry = (step: CalibrationStep): CalibrationProfileV2['retry'] => {
    if (step === 'passive-wait') {
        return { maxAttempts: 3, backoffMs: [300, 800, 1300], hardTimeoutMs: 12_000 };
    }
    if (step === 'endpoint-retry') {
        return { maxAttempts: 4, backoffMs: [400, 900, 1600, 2400], hardTimeoutMs: 20_000 };
    }
    return {
        maxAttempts: 6,
        backoffMs: [800, 1600, 2600, 3800, 5200, 7000],
        hardTimeoutMs: 30_000,
    };
};

/**
 * Build a calibration profile from a CalibrationStep using the manual-strict
 * policy. This is the centralized replacement for the runner's inline
 * `buildCalibrationProfile` + `buildCalibrationTimings` + `buildCalibrationRetry`.
 *
 * Manual-strict policy always:
 * - Sets `lastModifiedBy: 'manual'`
 * - Disables `['dom_hint', 'snapshot_fallback']`
 * - Uses tighter domQuietWindow for conservative (800ms vs 1200ms in generic defaults)
 */
export const buildCalibrationProfileFromStep = (platform: string, step: CalibrationStep): CalibrationProfileV2 => {
    return {
        schemaVersion: 2,
        platform,
        strategy: strategyFromStep(step),
        disabledSources: ['dom_hint', 'snapshot_fallback'],
        timingsMs: manualStrictTimings(step),
        retry: manualStrictRetry(step),
        updatedAt: new Date().toISOString(),
        lastModifiedBy: 'manual',
    };
};

export const validateCalibrationProfileV2 = (input: unknown, platform: string): CalibrationProfileV2 => {
    if (!isRecord(input)) {
        return buildDefaultCalibrationProfile(platform, 'conservative');
    }

    const strategy =
        typeof input.strategy === 'string' && ALLOWED_STRATEGY_SET.has(input.strategy as CalibrationStrategy)
            ? (input.strategy as CalibrationStrategy)
            : 'conservative';

    const defaults = buildDefaultCalibrationProfile(platform, strategy);

    const timingsMsInput = isRecord(input.timingsMs) ? input.timingsMs : {};
    const retryInput = isRecord(input.retry) ? input.retry : {};

    return {
        schemaVersion: 2,
        platform,
        strategy,
        disabledSources: normalizeSignalSources(input.disabledSources, defaults.disabledSources),
        timingsMs: {
            passiveWait: clampNumber(timingsMsInput.passiveWait, defaults.timingsMs.passiveWait, 100, 60_000),
            domQuietWindow: clampNumber(timingsMsInput.domQuietWindow, defaults.timingsMs.domQuietWindow, 100, 60_000),
            maxStabilizationWait: clampNumber(
                timingsMsInput.maxStabilizationWait,
                defaults.timingsMs.maxStabilizationWait,
                500,
                120_000,
            ),
        },
        retry: {
            maxAttempts: clampNumber(retryInput.maxAttempts, defaults.retry.maxAttempts, 1, 20),
            backoffMs: Array.isArray(retryInput.backoffMs)
                ? retryInput.backoffMs
                      .filter((item): item is number => typeof item === 'number' && Number.isFinite(item))
                      .map((item) => clampNumber(item, 1000, 0, 120_000))
                      .slice(0, 20)
                : defaults.retry.backoffMs,
            hardTimeoutMs: clampNumber(retryInput.hardTimeoutMs, defaults.retry.hardTimeoutMs, 500, 180_000),
        },
        updatedAt: typeof input.updatedAt === 'string' ? input.updatedAt : new Date().toISOString(),
        lastModifiedBy: input.lastModifiedBy === 'auto' ? 'auto' : 'manual',
    };
};

export const loadCalibrationProfileV2 = async (platform: string): Promise<CalibrationProfileV2> => {
    const existing = await loadCalibrationProfileV2IfPresent(platform);
    return existing ?? buildDefaultCalibrationProfile(platform, 'conservative');
};

export async function loadCalibrationProfileV2IfPresent(platform: string): Promise<CalibrationProfileV2 | null> {
    const result = await browser.storage.local.get(STORAGE_KEYS.CALIBRATION_PROFILES);
    const store = (result[STORAGE_KEYS.CALIBRATION_PROFILES] as CalibrationProfileV2Store | undefined) ?? {};
    if (!store[platform]) {
        return null;
    }
    return validateCalibrationProfileV2(store[platform], platform);
}

export const saveCalibrationProfileV2 = async (profile: CalibrationProfileV2) => {
    const normalized = validateCalibrationProfileV2(profile, profile.platform);
    const result = await browser.storage.local.get(STORAGE_KEYS.CALIBRATION_PROFILES);
    const store = (result[STORAGE_KEYS.CALIBRATION_PROFILES] as CalibrationProfileV2Store | undefined) ?? {};
    store[profile.platform] = {
        ...normalized,
        updatedAt: new Date().toISOString(),
    };
    await browser.storage.local.set({
        [STORAGE_KEYS.CALIBRATION_PROFILES]: store,
    });
};
