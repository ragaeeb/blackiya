import type { PlatformReadiness } from '@/platforms/types';
import type { ExportMeta } from '@/utils/sfe/types';

export const isDegradedCapture = (meta: ExportMeta | null | undefined) => {
    return meta?.fidelity === 'degraded';
};

export const shouldUseCachedConversationForWarmFetch = (
    readiness: PlatformReadiness,
    meta: ExportMeta | null | undefined,
) => {
    if (!readiness.ready) {
        return false;
    }
    return !isDegradedCapture(meta);
};

export const shouldIngestAsCanonicalSample = (meta: ExportMeta | null | undefined) => {
    return !isDegradedCapture(meta);
};
