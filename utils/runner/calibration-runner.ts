export type CalibrationStep = 'queue-flush' | 'passive-wait' | 'endpoint-retry' | 'page-snapshot';

export function prioritizeCalibrationStep(step: CalibrationStep, defaultOrder: CalibrationStep[]): CalibrationStep[] {
    return [step, ...defaultOrder.filter((candidate) => candidate !== step)];
}
