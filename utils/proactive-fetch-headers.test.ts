import { describe, expect, it } from 'bun:test';
import {
    extractForwardableHeadersFromFetchArgs,
    mergeHeaderRecords,
    toForwardableHeaderRecord,
} from '@/utils/proactive-fetch-headers';

describe('proactive fetch headers', () => {
    it('extracts forwardable auth/client headers from fetch args', () => {
        const request = new Request('https://chatgpt.com/backend-api/conversation/test/stream_status', {
            headers: {
                Authorization: 'Bearer token-1',
                'OAI-Client-Version': 'prod-abc',
                'OAI-Client-Build-Number': '123',
                'Sec-Fetch-Site': 'same-origin',
                Referer: 'https://chatgpt.com/c/test',
            },
        });

        const headers = extractForwardableHeadersFromFetchArgs([request]);
        expect(headers).toBeDefined();
        expect(headers?.authorization).toBe('Bearer token-1');
        expect(headers?.['oai-client-version']).toBe('prod-abc');
        expect(headers?.['oai-client-build-number']).toBe('123');
        expect(headers?.['sec-fetch-site']).toBeUndefined();
        expect(headers?.referer).toBeUndefined();
    });

    it('normalizes object headers and strips forbidden names', () => {
        const headers = toForwardableHeaderRecord({
            authorization: 'Bearer token-2',
            cookie: 'blocked',
            'user-agent': 'blocked',
            'oai-device-id': 'device-1',
            'accept-language': 'en-US',
        });

        expect(headers).toEqual({
            authorization: 'Bearer token-2',
            'oai-device-id': 'device-1',
            'accept-language': 'en-US',
        });
    });

    it('merges incoming headers over existing values', () => {
        const merged = mergeHeaderRecords(
            {
                authorization: 'Bearer old',
                'oai-client-version': 'old-version',
            },
            {
                authorization: 'Bearer new',
                'oai-device-id': 'device-new',
            },
        );

        expect(merged).toEqual({
            authorization: 'Bearer new',
            'oai-client-version': 'old-version',
            'oai-device-id': 'device-new',
        });
    });
});
