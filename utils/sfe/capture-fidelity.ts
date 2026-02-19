import type { PlatformReadiness } from '@/platforms/types';
import type { ExportMeta } from '@/utils/sfe/types';

export function isDegradedCapture(meta: ExportMeta | null | undefined) {
    return meta?.fidelity === 'degraded';
}

export function shouldUseCachedConversationForWarmFetch(
    readiness: PlatformReadiness,
    meta: ExportMeta | null | undefined,
) {
    if (!readiness.ready) {
        return false;
    }
    return !isDegradedCapture(meta);
}

export function shouldIngestAsCanonicalSample(meta: ExportMeta | null | undefined) {
    return !isDegradedCapture(meta);
}
