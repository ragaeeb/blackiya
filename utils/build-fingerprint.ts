type BuildFingerprint = {
    label: string;
    buildId: string;
    commit: string;
    createdAt: string;
};

declare const __BLACKIYA_BUILD_LABEL__: string | undefined;
declare const __BLACKIYA_BUILD_ID__: string | undefined;
declare const __BLACKIYA_BUILD_COMMIT__: string | undefined;
declare const __BLACKIYA_BUILD_CREATED_AT__: string | undefined;

const FALLBACK_FINGERPRINT: BuildFingerprint = {
    label: 'Mellow Marmot (local-dev)',
    buildId: 'local-dev',
    commit: 'unknown',
    createdAt: 'unknown',
};

const asOptionalString = (value: unknown): string | null =>
    typeof value === 'string' && value.length > 0 ? value : null;

const sanitizeFilenamePart = (value: string): string =>
    value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80);

export const getBuildFingerprint = (): BuildFingerprint => {
    const runtime = globalThis as Record<string, unknown>;
    const compileLabel = typeof __BLACKIYA_BUILD_LABEL__ !== 'undefined' ? __BLACKIYA_BUILD_LABEL__ : undefined;
    const compileBuildId = typeof __BLACKIYA_BUILD_ID__ !== 'undefined' ? __BLACKIYA_BUILD_ID__ : undefined;
    const compileCommit = typeof __BLACKIYA_BUILD_COMMIT__ !== 'undefined' ? __BLACKIYA_BUILD_COMMIT__ : undefined;
    const compileCreatedAt =
        typeof __BLACKIYA_BUILD_CREATED_AT__ !== 'undefined' ? __BLACKIYA_BUILD_CREATED_AT__ : undefined;

    const label = asOptionalString(compileLabel) ?? asOptionalString(runtime.__BLACKIYA_BUILD_LABEL__);
    const buildId = asOptionalString(compileBuildId) ?? asOptionalString(runtime.__BLACKIYA_BUILD_ID__);
    const commit = asOptionalString(compileCommit) ?? asOptionalString(runtime.__BLACKIYA_BUILD_COMMIT__);
    const createdAt =
        asOptionalString(compileCreatedAt) ?? asOptionalString(runtime.__BLACKIYA_BUILD_CREATED_AT__);

    if (!label || !buildId || !commit || !createdAt) {
        return FALLBACK_FINGERPRINT;
    }

    return {
        label,
        buildId,
        commit,
        createdAt,
    };
};

export const getBuildFilenameTag = (): string => {
    const fingerprint = getBuildFingerprint();
    const tag = sanitizeFilenamePart(fingerprint.label || fingerprint.buildId);
    return tag.length > 0 ? tag : 'mellow-marmot-local-dev';
};
