import { describe, expect, it } from 'bun:test';
import { buildCalibrationOrderForMode, shouldPersistCalibrationProfile } from '@/utils/runner/calibration-policy';

describe('calibration-policy', () => {
    describe('buildCalibrationOrderForMode', () => {
        it('should return default order when no preferred step is provided', () => {
            const order = buildCalibrationOrderForMode(null, 'manual');
            expect(order).toEqual(['queue-flush', 'passive-wait', 'endpoint-retry', 'page-snapshot']);
        });

        it('should reorder specific default order for ChatGPT auto mode with page-snapshot preference', () => {
            const order = buildCalibrationOrderForMode('page-snapshot', 'auto', 'ChatGPT');
            expect(order).toEqual(['queue-flush', 'page-snapshot', 'passive-wait', 'endpoint-retry']);
        });

        it('should use default order for non-ChatGPT platform auto mode with page-snapshot preference', () => {
            const order = buildCalibrationOrderForMode('page-snapshot', 'auto', 'Grok');
            expect(order).toEqual(['queue-flush', 'passive-wait', 'endpoint-retry', 'page-snapshot']);
        });

        it('should prioritize the preferred step for manual mode', () => {
            const order = buildCalibrationOrderForMode('endpoint-retry', 'manual');
            expect(order).toEqual(['endpoint-retry', 'queue-flush', 'passive-wait', 'page-snapshot']);
        });

        it('should keep page-snapshot last in auto mode even with other preferred step', () => {
            const order = buildCalibrationOrderForMode('endpoint-retry', 'auto');
            expect(order).toEqual(['endpoint-retry', 'queue-flush', 'passive-wait', 'page-snapshot']);
        });

        it('should keep page-snapshot last in auto mode even if preferred step is page-snapshot but platform is not ChatGPT', () => {
            const order = buildCalibrationOrderForMode('page-snapshot', 'auto', 'Gemini');
            expect(order).toEqual(['queue-flush', 'passive-wait', 'endpoint-retry', 'page-snapshot']);
        });
    });

    describe('shouldPersistCalibrationProfile', () => {
        it('should return true for manual mode', () => {
            expect(shouldPersistCalibrationProfile('manual')).toBeTrue();
        });

        it('should return false for auto mode', () => {
            expect(shouldPersistCalibrationProfile('auto')).toBeFalse();
        });
    });
});
