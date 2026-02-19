import { describe, expect, it } from 'bun:test';
import { shouldPersistCalibrationProfile } from '@/utils/runner/calibration-policy';

describe('Calibration profile persistence policy', () => {
    it('persists profile updates for manual calibration runs', () => {
        expect(shouldPersistCalibrationProfile('manual')).toBeTrue();
    });

    it('does not persist profile timestamps for auto calibration runs', () => {
        expect(shouldPersistCalibrationProfile('auto')).toBeFalse();
    });
});
