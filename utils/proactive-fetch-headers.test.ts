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

        const headers = extractForwardableHeadersFromFetchArgs([request], 'ChatGPT');
        expect(headers).toBeDefined();
        expect(headers?.authorization).toBe('Bearer token-1');
        expect(headers?.['oai-client-version']).toBe('prod-abc');
        expect(headers?.['oai-client-build-number']).toBe('123');
        expect(headers?.['sec-fetch-site']).toBeUndefined();
        expect(headers?.referer).toBeUndefined();
    });

    it('keeps only provider-allowed ChatGPT headers', () => {
        const headers = toForwardableHeaderRecord(
            {
                authorization: 'Bearer token-2',
                cookie: 'blocked',
                'user-agent': 'blocked',
                'oai-device-id': 'device-1',
                'accept-language': 'en-US',
                'x-api-key': 'blocked-api-key',
                'x-csrf-token': 'blocked-csrf-token',
                'x-request-signature': 'blocked-signature',
                'x-custom-secret': 'blocked-custom-header',
            },
            'ChatGPT',
        );

        expect(headers).toEqual({
            authorization: 'Bearer token-2',
            'oai-device-id': 'device-1',
        });
    });

    it('keeps provider-specific Gemini auth context but rejects endpoint secrets', () => {
        const headers = toForwardableHeaderRecord(
            {
                authorization: 'Bearer gemini-token',
                'x-goog-authuser': '0',
                'x-goog-visitor-id': 'visitor-1',
                'x-goog-api-key': 'blocked-api-key',
                'x-csrf-token': 'blocked-csrf-token',
                'x-goog-signature': 'blocked-signature',
                'x-custom-header': 'blocked-custom-header',
            },
            'Gemini',
        );

        expect(headers).toEqual({
            authorization: 'Bearer gemini-token',
            'x-goog-authuser': '0',
            'x-goog-visitor-id': 'visitor-1',
        });
    });

    it('keeps Grok authorization but rejects unrelated custom credentials', () => {
        const headers = toForwardableHeaderRecord(
            {
                authorization: 'Bearer grok-token',
                'x-api-key': 'blocked-api-key',
                'x-csrf-token': 'blocked-csrf-token',
                'x-signature': 'blocked-signature',
                'x-custom-header': 'blocked-custom-header',
            },
            'Grok',
        );

        expect(headers).toEqual({ authorization: 'Bearer grok-token' });
    });

    it('fails closed when no supported provider is supplied', () => {
        expect(toForwardableHeaderRecord({ authorization: 'Bearer token' })).toBeUndefined();
        expect(extractForwardableHeadersFromFetchArgs(['https://chatgpt.com/c/test'])).toBeUndefined();
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
