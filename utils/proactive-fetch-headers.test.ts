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

    it('keeps Grok and x.com request context but rejects unrelated custom credentials', () => {
        const headers = toForwardableHeaderRecord(
            {
                authorization: 'Bearer grok-token',
                'x-api-key': 'blocked-api-key',
                'x-csrf-token': 'csrf-token',
                'x-twitter-active-user': 'yes',
                'x-twitter-auth-type': 'OAuth2Session',
                'x-twitter-client-language': 'en',
                'x-client-transaction-id': 'blocked-ephemeral-transaction',
                'x-signature': 'blocked-signature',
                'x-custom-header': 'blocked-custom-header',
            },
            'Grok',
        );

        expect(headers).toEqual({
            authorization: 'Bearer grok-token',
            'x-csrf-token': 'csrf-token',
            'x-twitter-active-user': 'yes',
            'x-twitter-auth-type': 'OAuth2Session',
            'x-twitter-client-language': 'en',
        });
    });

    it('keeps only bounded request context for newly supported providers', () => {
        expect(
            toForwardableHeaderRecord(
                { 'bx-umidtoken': 'qwen-context', 'bx-ua': 'ua-context', authorization: 'blocked' },
                'Qwen',
            ),
        ).toEqual({ 'bx-umidtoken': 'qwen-context', 'bx-ua': 'ua-context' });
        expect(
            toForwardableHeaderRecord(
                {
                    authorization: 'Bearer deepseek-token',
                    'x-client-version': 'deepseek-version',
                    'x-client-platform': 'web',
                    cookie: 'blocked',
                },
                'DeepSeek',
            ),
        ).toEqual({
            authorization: 'Bearer deepseek-token',
            'x-client-version': 'deepseek-version',
            'x-client-platform': 'web',
        });
        expect(toForwardableHeaderRecord({ 'x-region': 'synthetic-region', cookie: 'blocked' }, 'Z.ai')).toEqual({
            'x-region': 'synthetic-region',
        });
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
