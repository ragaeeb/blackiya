/**
 * Cross-world page snapshot bridge.
 *
 * Sends a `BLACKIYA_PAGE_SNAPSHOT_REQUEST` to the MAIN world and waits for
 * the response. Fully standalone — no runner-state dependencies.
 */

import { resolveTokenValidationFailureReason, stampToken } from '@/utils/protocol/session-token';

const SNAPSHOT_TIMEOUT_MS = 2500;

const generateSnapshotRequestId = (): string =>
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `snapshot-${Date.now()}-${Math.random().toString(16).slice(2)}`;

export const requestPageSnapshot = (conversationId: string): Promise<unknown | null> => {
    const requestId = generateSnapshotRequestId();

    return new Promise((resolve) => {
        const timeout = window.setTimeout(() => {
            window.removeEventListener('message', onMessage);
            resolve(null);
        }, SNAPSHOT_TIMEOUT_MS);

        const onMessage = (event: MessageEvent) => {
            if (event.source !== window || event.origin !== window.location.origin) {
                return;
            }
            const msg = event.data as Record<string, unknown> | null;
            if (
                msg?.type !== 'BLACKIYA_PAGE_SNAPSHOT_RESPONSE' ||
                msg.requestId !== requestId ||
                resolveTokenValidationFailureReason(msg) !== null
            ) {
                return;
            }
            clearTimeout(timeout);
            window.removeEventListener('message', onMessage);
            resolve(msg.success ? msg.data : null);
        };

        window.addEventListener('message', onMessage);
        window.postMessage(
            stampToken({ type: 'BLACKIYA_PAGE_SNAPSHOT_REQUEST', requestId, conversationId }),
            window.location.origin,
        );
    });
};
