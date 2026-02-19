/**
 * Pure display-logic helpers for calibration button state.
 * These have no side effects and are fully testable without a DOM.
 */

import type { RunnerCalibrationUiState } from '@/utils/runner/state';

/**
 * Formats a human-readable age label for the calibration profile timestamp.
 * Returns `null` when the timestamp is absent or unparseable.
 *
 * Examples: `'just now'`, `'5m ago'`, `'3h ago'`, `'Jan 12'`
 */
export const formatCalibrationTimestampLabel = (updatedAt: string | null): string | null => {
    if (!updatedAt) {
        return null;
    }
    const parsed = new Date(updatedAt);
    if (Number.isNaN(parsed.getTime())) {
        return null;
    }
    const ageMs = Math.max(0, Date.now() - parsed.getTime());
    const minuteMs = 60_000;
    const hourMs = 60 * minuteMs;
    const dayMs = 24 * hourMs;
    if (ageMs < minuteMs) {
        return 'just now';
    }
    if (ageMs < hourMs) {
        return `${Math.floor(ageMs / minuteMs)}m ago`;
    }
    if (ageMs < dayMs) {
        return `${Math.floor(ageMs / hourMs)}h ago`;
    }
    return parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

/**
 * Resolves the effective calibration state to display on the button.
 * When the runner is `idle` but already has a remembered preferred step,
 * returns `success` to indicate calibration is already configured.
 */
export const resolveCalibrationDisplayState = (
    calibrationState: RunnerCalibrationUiState,
    hasRememberedStep: boolean,
): RunnerCalibrationUiState => {
    if (calibrationState === 'idle' && hasRememberedStep) {
        return 'success';
    }
    return calibrationState;
};
