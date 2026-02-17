import { browser } from 'wxt/browser';
import { STORAGE_KEYS } from '@/utils/settings';
import type { SignalSource } from '@/utils/sfe/types';

export type CalibrationStrategy = 'aggressive' | 'balanced' | 'conservative';

export interface CalibrationProfileV2 {
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
}

export type CalibrationProfileV2Store = Record<string, CalibrationProfileV2>;

const ALLOWED_SOURCE_SET = new Set<SignalSource>([
    'network_stream',
    'completion_endpoint',
    'canonical_fetch',
    'dom_hint',
    'snapshot_fallback',
]);

const ALLOWED_STRATEGY_SET = new Set<CalibrationStrategy>(['aggressive', 'balanced', 'conservative']);

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return fallback;
    }
    return Math.max(min, Math.min(max, value));
}

function normalizeSignalSources(value: unknown): SignalSource[] {
    if (!Array.isArray(value)) {
        return ['dom_hint', 'snapshot_fallback'];
    }
    const normalized = value.filter(
        (source): source is SignalSource =>
            typeof source === 'string' && ALLOWED_SOURCE_SET.has(source as SignalSource),
    );
    return Array.from(new Set(normalized));
}

function strategyDefaults(strategy: CalibrationStrategy): CalibrationProfileV2 {
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
        strategy: 'conservative',
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
}

export function buildDefaultCalibrationProfile(
    platform: string,
    strategy: CalibrationStrategy = 'conservative',
): CalibrationProfileV2 {
    const defaults = strategyDefaults(strategy);
    return {
        ...defaults,
        platform,
        updatedAt: new Date().toISOString(),
    };
}

export function validateCalibrationProfileV2(input: unknown, platform: string): CalibrationProfileV2 {
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
        disabledSources: normalizeSignalSources(input.disabledSources),
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
}

export async function loadCalibrationProfileV2(platform: string): Promise<CalibrationProfileV2> {
    const existing = await loadCalibrationProfileV2IfPresent(platform);
    return existing ?? buildDefaultCalibrationProfile(platform, 'conservative');
}

export async function loadCalibrationProfileV2IfPresent(platform: string): Promise<CalibrationProfileV2 | null> {
    const result = await browser.storage.local.get(STORAGE_KEYS.CALIBRATION_PROFILES);
    const store = (result[STORAGE_KEYS.CALIBRATION_PROFILES] as CalibrationProfileV2Store | undefined) ?? {};
    if (!store[platform]) {
        return null;
    }
    return validateCalibrationProfileV2(store[platform], platform);
}

export async function saveCalibrationProfileV2(profile: CalibrationProfileV2): Promise<void> {
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
}
