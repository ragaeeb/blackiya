import { describe, expect, it, mock } from 'bun:test';
import { dispatchRunnerMessage } from '@/utils/runner/message-bridge';

describe('message-bridge', () => {
    describe('dispatchRunnerMessage', () => {
        it('should return true and stop if a handler returns true', () => {
            const h1 = mock(() => false);
            const h2 = mock(() => true);
            const h3 = mock(() => false);

            const msg = { type: 'test' };
            const result = dispatchRunnerMessage(msg, [h1, h2, h3]);

            expect(result).toBeTrue();
            expect(h1).toHaveBeenCalledWith(msg);
            expect(h2).toHaveBeenCalledWith(msg);
            expect(h3).not.toHaveBeenCalled();
        });

        it('should return false if no handler returns true', () => {
            const h1 = mock(() => false);
            const h2 = mock(() => false);

            const msg = { type: 'test' };
            const result = dispatchRunnerMessage(msg, [h1, h2]);

            expect(result).toBeFalse();
            expect(h1).toHaveBeenCalledWith(msg);
            expect(h2).toHaveBeenCalledWith(msg);
        });

        it('should return false if no handlers provided', () => {
            expect(dispatchRunnerMessage({}, [])).toBeFalse();
        });
    });
});
