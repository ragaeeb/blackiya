import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { formatCalibrationTimestampLabel, resolveCalibrationDisplayState } from '@/utils/runner/calibration-ui';

describe('calibration-ui', () => {
    describe('formatCalibrationTimestampLabel', () => {
        let originalDateNow: typeof Date.now;

        beforeEach(() => {
            originalDateNow = globalThis.Date.now;
        });

        afterEach(() => {
            globalThis.Date.now = originalDateNow;
        });

        it('should return null if updatedAt is null', () => {
            expect(formatCalibrationTimestampLabel(null)).toBeNull();
        });

        it('should return null if updatedAt is unparseable', () => {
            expect(formatCalibrationTimestampLabel('invalid-date')).toBeNull();
        });

        it('should return "just now" if age is less than a minute', () => {
            const now = new Date('2023-01-01T12:00:00Z').getTime();
            globalThis.Date.now = () => now;

            const updatedAt = new Date(now - 30_000).toISOString(); // 30 seconds ago
            expect(formatCalibrationTimestampLabel(updatedAt)).toBe('just now');
        });

        it('should format as "m ago" if age is less than an hour', () => {
            const now = new Date('2023-01-01T12:00:00Z').getTime();
            globalThis.Date.now = () => now;

            const updatedAt = new Date(now - 15 * 60_000).toISOString(); // 15 mins ago
            expect(formatCalibrationTimestampLabel(updatedAt)).toBe('15m ago');
        });

        it('should format as "h ago" if age is less than a day', () => {
            const now = new Date('2023-01-01T12:00:00Z').getTime();
            globalThis.Date.now = () => now;

            const updatedAt = new Date(now - 5 * 3600_000).toISOString(); // 5 hours ago
            expect(formatCalibrationTimestampLabel(updatedAt)).toBe('5h ago');
        });

        it('should format as a date if age is greater than a day', () => {
            const now = new Date('2023-01-05T12:00:00Z').getTime();
            globalThis.Date.now = () => now;

            // The toLocaleDateString result depends on the environment locale,
            // but we'll mock it or just verify it's a non-empty string that matches the locale formatting
            const date = new Date(now - 3 * 24 * 3600_000); // 3 days ago (Jan 2)
            const formatted = formatCalibrationTimestampLabel(date.toISOString());
            expect(formatted).toBe(date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }));
        });

        it('should handle dates in the future safely (e.g. clock sync issues)', () => {
            const now = new Date('2023-01-01T12:00:00Z').getTime();
            globalThis.Date.now = () => now;

            const futureDate = new Date(now + 60_000).toISOString(); // 1 minute in the future
            expect(formatCalibrationTimestampLabel(futureDate)).toBe('just now'); // math.max kicks in to 0
        });
    });

    describe('resolveCalibrationDisplayState', () => {
        it('should return success if state is idle but has remembered step', () => {
            expect(resolveCalibrationDisplayState('idle', true)).toBe('success');
        });

        it('should return idle if state is idle and has no remembered step', () => {
            expect(resolveCalibrationDisplayState('idle', false)).toBe('idle');
        });

        it('should pass through other states unchanged', () => {
            expect(resolveCalibrationDisplayState('waiting', true)).toBe('waiting');
            expect(resolveCalibrationDisplayState('capturing', false)).toBe('capturing');
            expect(resolveCalibrationDisplayState('error', true)).toBe('error');
        });
    });
});
