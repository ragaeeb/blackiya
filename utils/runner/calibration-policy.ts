import { type CalibrationStep, prioritizeCalibrationStep } from '@/utils/runner/calibration-runner';

export type CalibrationMode = 'manual' | 'auto';

export const buildCalibrationOrderForMode = (
    preferredStep: CalibrationStep | null,
    mode: CalibrationMode,
    platformName?: string,
): CalibrationStep[] => {
    const defaultOrder: CalibrationStep[] = ['queue-flush', 'passive-wait', 'endpoint-retry', 'page-snapshot'];
    if (!preferredStep) {
        return defaultOrder;
    }

    if (mode === 'auto' && preferredStep === 'page-snapshot') {
        // For ChatGPT, snapshot fallback is currently the most reliable and avoids long endpoint-retry delays.
        if (platformName === 'ChatGPT') {
            return ['queue-flush', 'page-snapshot', 'passive-wait', 'endpoint-retry'];
        }
        return defaultOrder;
    }

    const reordered = prioritizeCalibrationStep(preferredStep, defaultOrder);
    if (mode !== 'auto') {
        return reordered;
    }

    // In auto mode, keep page-snapshot as a last resort to reduce premature partial captures.
    const withoutSnapshot = reordered.filter((step) => step !== 'page-snapshot');
    return [...withoutSnapshot, 'page-snapshot'];
};

export const shouldPersistCalibrationProfile = (mode: CalibrationMode): boolean => {
    return mode === 'manual';
};
