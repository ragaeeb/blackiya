import { describe, expect, it, mock } from 'bun:test';
import { buildExportMetaForSave, confirmDegradedForceSave } from '@/utils/runner/save-export';

describe('save-export', () => {
    describe('buildExportMetaForSave', () => {
        it('should use degraded override if allowDegraded is true', () => {
            const getCaptureMeta = mock(
                () => ({ captureSource: 'canonical_api', fidelity: 'high', completeness: 'complete' }) as any,
            );
            const result = buildExportMetaForSave('conv-1', true, getCaptureMeta);
            expect(result).toEqual({
                captureSource: 'dom_snapshot_degraded',
                fidelity: 'degraded',
                completeness: 'partial',
            });
            expect(getCaptureMeta).not.toHaveBeenCalled();
        });

        it('should use getter if allowDegraded is falsy', () => {
            const meta = { captureSource: 'canonical_api', fidelity: 'high', completeness: 'complete' } as any;
            const getCaptureMeta = mock(() => meta);

            const result1 = buildExportMetaForSave('conv-1', false, getCaptureMeta);
            expect(result1).toBe(meta);

            const result2 = buildExportMetaForSave('conv-1', undefined, getCaptureMeta);
            expect(result2).toBe(meta);

            expect(getCaptureMeta).toHaveBeenCalledTimes(2);
            expect(getCaptureMeta).toHaveBeenCalledWith('conv-1');
        });
    });

    describe('confirmDegradedForceSave', () => {
        it('should return true if window.confirm is not a function', () => {
            const originalWindow = (globalThis as any).window;
            (globalThis as any).window = { confirm: undefined };

            expect(confirmDegradedForceSave()).toBeTrue();

            (globalThis as any).window = originalWindow;
        });

        it('should use window.confirm if available', () => {
            const originalWindow = (globalThis as any).window;

            (globalThis as any).window = { confirm: mock(() => false) };
            expect(confirmDegradedForceSave()).toBeFalse();

            (globalThis as any).window = { confirm: mock(() => true) };
            expect(confirmDegradedForceSave()).toBeTrue();

            (globalThis as any).window = originalWindow;
        });
    });
});
