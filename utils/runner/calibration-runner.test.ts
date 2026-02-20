import { describe, expect, it } from 'bun:test';
import { type CalibrationStep, prioritizeCalibrationStep } from '@/utils/runner/calibration-runner';

describe('calibration-runner', () => {
    describe('prioritizeCalibrationStep', () => {
        it('should move an existing step to the front of the array', () => {
            const defaultOrder: CalibrationStep[] = ['queue-flush', 'passive-wait', 'endpoint-retry', 'page-snapshot'];
            const prioritized = prioritizeCalibrationStep('endpoint-retry', defaultOrder);
            expect(prioritized).toEqual(['endpoint-retry', 'queue-flush', 'passive-wait', 'page-snapshot']);
        });

        it('should append a step if it is not in the default order', () => {
            const defaultOrder: CalibrationStep[] = ['queue-flush', 'passive-wait'];
            const prioritized = prioritizeCalibrationStep('page-snapshot', defaultOrder);
            expect(prioritized).toEqual(['queue-flush', 'passive-wait', 'page-snapshot']);
        });

        it('should return identical array structure if step is already first', () => {
            const defaultOrder: CalibrationStep[] = ['queue-flush', 'passive-wait'];
            const prioritized = prioritizeCalibrationStep('queue-flush', defaultOrder);
            expect(prioritized).toEqual(['queue-flush', 'passive-wait']);
        });
    });
});
