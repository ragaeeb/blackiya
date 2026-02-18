import type { ResponseLifecycleMessage } from '@/utils/protocol/messages';

export function getLifecyclePhasePriority(phase: ResponseLifecycleMessage['phase']) {
    if (phase === 'prompt-sent') {
        return 1;
    }
    if (phase === 'streaming') {
        return 2;
    }
    if (phase === 'completed') {
        return 3;
    }
    if (phase === 'terminated') {
        return 4;
    }
    return 0;
}

export function isRegressiveLifecycleTransition(
    current: ResponseLifecycleMessage['phase'],
    next: ResponseLifecycleMessage['phase'],
) {
    return getLifecyclePhasePriority(next) < getLifecyclePhasePriority(current);
}
