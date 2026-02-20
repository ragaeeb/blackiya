import type { CalibrationStep } from '@/utils/calibration-profile';

export type { CalibrationStep };

export const prioritizeCalibrationStep = (
    step: CalibrationStep,
    defaultOrder: CalibrationStep[],
): CalibrationStep[] => {
    if (defaultOrder.includes(step)) {
        return [step, ...defaultOrder.filter((candidate) => candidate !== step)];
    }
    return [...defaultOrder, step];
};
