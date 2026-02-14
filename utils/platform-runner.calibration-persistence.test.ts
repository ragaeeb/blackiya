import { describe, expect, it } from 'bun:test';
import { shouldPersistCalibrationProfile } from '@/utils/platform-runner';

describe('Calibration profile persistence policy', () => {
    it('persists profile updates for manual calibration runs', () => {
        expect(shouldPersistCalibrationProfile('manual')).toBe(true);
    });

    it('does not persist profile timestamps for auto calibration runs', () => {
        expect(shouldPersistCalibrationProfile('auto')).toBe(false);
    });
});
