export type ProbeLeaseClaimRequest = {
    type: 'BLACKIYA_PROBE_LEASE_CLAIM';
    conversationId: string;
    attemptId: string;
    ttlMs: number;
};

export type ProbeLeaseReleaseRequest = {
    type: 'BLACKIYA_PROBE_LEASE_RELEASE';
    conversationId: string;
    attemptId: string;
};

export type ProbeLeaseClaimResponse = {
    type: 'BLACKIYA_PROBE_LEASE_CLAIM_RESULT';
    acquired: boolean;
    ownerAttemptId: string | null;
    expiresAtMs: number | null;
};

export type ProbeLeaseReleaseResponse = {
    type: 'BLACKIYA_PROBE_LEASE_RELEASE_RESULT';
    released: boolean;
};

export type ProbeLeaseRuntimeMessage = ProbeLeaseClaimRequest | ProbeLeaseReleaseRequest;
export type ProbeLeaseRuntimeResponse = ProbeLeaseClaimResponse | ProbeLeaseReleaseResponse;

const isRecord = (value: unknown): value is Record<string, unknown> => {
    return !!value && typeof value === 'object' && !Array.isArray(value);
};

const hasNonEmptyString = (value: unknown): value is string => {
    return typeof value === 'string' && value.length > 0;
};

export const isProbeLeaseClaimRequest = (value: unknown): value is ProbeLeaseClaimRequest => {
    if (!isRecord(value) || value.type !== 'BLACKIYA_PROBE_LEASE_CLAIM') {
        return false;
    }
    return (
        hasNonEmptyString(value.conversationId) && hasNonEmptyString(value.attemptId) && typeof value.ttlMs === 'number'
    );
};

export const isProbeLeaseReleaseRequest = (value: unknown): value is ProbeLeaseReleaseRequest => {
    if (!isRecord(value) || value.type !== 'BLACKIYA_PROBE_LEASE_RELEASE') {
        return false;
    }
    return hasNonEmptyString(value.conversationId) && hasNonEmptyString(value.attemptId);
};

export const isProbeLeaseClaimResponse = (value: unknown): value is ProbeLeaseClaimResponse => {
    if (!isRecord(value) || value.type !== 'BLACKIYA_PROBE_LEASE_CLAIM_RESULT') {
        return false;
    }
    const ownerAttemptIdValid = value.ownerAttemptId === null || hasNonEmptyString(value.ownerAttemptId);
    const expiresAtMsValid = value.expiresAtMs === null || typeof value.expiresAtMs === 'number';
    return typeof value.acquired === 'boolean' && ownerAttemptIdValid && expiresAtMsValid;
};

export const isProbeLeaseReleaseResponse = (value: unknown): value is ProbeLeaseReleaseResponse => {
    if (!isRecord(value) || value.type !== 'BLACKIYA_PROBE_LEASE_RELEASE_RESULT') {
        return false;
    }
    return typeof value.released === 'boolean';
};
