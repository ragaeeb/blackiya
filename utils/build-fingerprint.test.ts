import { afterEach, describe, expect, it } from 'bun:test';
import { getBuildFilenameTag, getBuildFingerprint } from '@/utils/build-fingerprint';

type RuntimeWithBuildFingerprint = typeof globalThis & {
    __BLACKIYA_BUILD_LABEL__?: unknown;
    __BLACKIYA_BUILD_ID__?: unknown;
    __BLACKIYA_BUILD_COMMIT__?: unknown;
    __BLACKIYA_BUILD_CREATED_AT__?: unknown;
};

const runtime = globalThis as RuntimeWithBuildFingerprint;

const clearRuntimeBuildFingerprint = () => {
    delete runtime.__BLACKIYA_BUILD_LABEL__;
    delete runtime.__BLACKIYA_BUILD_ID__;
    delete runtime.__BLACKIYA_BUILD_COMMIT__;
    delete runtime.__BLACKIYA_BUILD_CREATED_AT__;
};

describe('build-fingerprint', () => {
    afterEach(() => {
        clearRuntimeBuildFingerprint();
    });

    it('should return fallback fingerprint when build constants are missing', () => {
        clearRuntimeBuildFingerprint();

        expect(getBuildFingerprint()).toEqual({
            label: 'Mellow Marmot (local-dev)',
            buildId: 'local-dev',
            commit: 'unknown',
            createdAt: 'unknown',
        });
    });

    it('should read runtime-provided fingerprint values', () => {
        runtime.__BLACKIYA_BUILD_LABEL__ = 'Fuzzy Falcon';
        runtime.__BLACKIYA_BUILD_ID__ = 'falcon-dev';
        runtime.__BLACKIYA_BUILD_COMMIT__ = '3be0623';
        runtime.__BLACKIYA_BUILD_CREATED_AT__ = '2026-03-04T01:14:35.210Z';

        expect(getBuildFingerprint()).toEqual({
            label: 'Fuzzy Falcon',
            buildId: 'falcon-dev',
            commit: '3be0623',
            createdAt: '2026-03-04T01:14:35.210Z',
        });
        expect(getBuildFilenameTag()).toBe('fuzzy-falcon');
    });
});
