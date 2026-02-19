import { describe, expect, it } from 'bun:test';
import { buildCalibrationOrderForMode } from '@/utils/runner/calibration-policy';

describe('Calibration order strategy', () => {
    it('returns default order when no preferred step exists', () => {
        expect(buildCalibrationOrderForMode(null, 'auto', 'ChatGPT')).toEqual([
            'queue-flush',
            'passive-wait',
            'endpoint-retry',
            'page-snapshot',
        ]);
    });

    it('prioritizes page-snapshot early for ChatGPT auto mode when remembered step is page-snapshot', () => {
        expect(buildCalibrationOrderForMode('page-snapshot', 'auto', 'ChatGPT')).toEqual([
            'queue-flush',
            'page-snapshot',
            'passive-wait',
            'endpoint-retry',
        ]);
    });

    it('keeps page-snapshot as last resort for non-ChatGPT auto mode', () => {
        expect(buildCalibrationOrderForMode('page-snapshot', 'auto', 'Gemini')).toEqual([
            'queue-flush',
            'passive-wait',
            'endpoint-retry',
            'page-snapshot',
        ]);
    });

    it('uses remembered step first for manual mode', () => {
        expect(buildCalibrationOrderForMode('endpoint-retry', 'manual', 'ChatGPT')).toEqual([
            'endpoint-retry',
            'queue-flush',
            'passive-wait',
            'page-snapshot',
        ]);
    });
});
