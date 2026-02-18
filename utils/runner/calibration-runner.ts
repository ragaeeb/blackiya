import type { CalibrationStep } from '@/utils/calibration-profile';

export type { CalibrationStep };

export function prioritizeCalibrationStep(step: CalibrationStep, defaultOrder: CalibrationStep[]): CalibrationStep[] {
    if (defaultOrder.includes(step)) {
        return [step, ...defaultOrder.filter((candidate) => candidate !== step)];
    }
    return [...defaultOrder, step];
}
