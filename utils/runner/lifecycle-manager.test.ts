import { describe, expect, it } from 'bun:test';
import { getLifecyclePhasePriority, isRegressiveLifecycleTransition } from '@/utils/runner/lifecycle-manager';

describe('lifecycle-manager', () => {
    describe('getLifecyclePhasePriority', () => {
        it('should return correct priorities', () => {
            expect(getLifecyclePhasePriority('prompt-sent')).toBe(1);
            expect(getLifecyclePhasePriority('streaming')).toBe(2);
            expect(getLifecyclePhasePriority('completed')).toBe(3);
            expect(getLifecyclePhasePriority('terminated')).toBe(4);
            expect(getLifecyclePhasePriority('unknown' as any)).toBe(0);
        });
    });

    describe('isRegressiveLifecycleTransition', () => {
        it('should return true if transition goes backwards', () => {
            expect(isRegressiveLifecycleTransition('completed', 'streaming')).toBeTrue();
            expect(isRegressiveLifecycleTransition('streaming', 'prompt-sent')).toBeTrue();
            expect(isRegressiveLifecycleTransition('terminated', 'completed')).toBeTrue();
        });

        it('should return false if transition goes forwards or stays same', () => {
            expect(isRegressiveLifecycleTransition('prompt-sent', 'streaming')).toBeFalse();
            expect(isRegressiveLifecycleTransition('streaming', 'completed')).toBeFalse();
            expect(isRegressiveLifecycleTransition('completed', 'completed')).toBeFalse();
            expect(isRegressiveLifecycleTransition('prompt-sent', 'prompt-sent')).toBeFalse();
        });
    });
});
