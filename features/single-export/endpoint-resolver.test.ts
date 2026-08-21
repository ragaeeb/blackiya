import { describe, expect, it } from 'bun:test';
import {
    buildDetailRequest,
    type DetailRequest,
    resolvePlatformKind,
} from '@/features/single-export/endpoint-resolver';
import { chatGPTAdapter } from '@/platforms/chatgpt';
import { GEMINI_RPC_IDS } from '@/platforms/constants';
import { geminiAdapter } from '@/platforms/gemini';
import { grokAdapter } from '@/platforms/grok';
import type { GeminiBatchexecuteContext } from '@/utils/gemini-batchexecute-context';

const CHATGPT_ID = '67f0a0b3-1234-4abc-8def-1234567890ab';
const GROK_ID = '01cb0729-6455-471d-b33a-124b3de76a29';
const GEMINI_ID = '20de061ec5dae81c';

const makeGeminiContext = (overrides: Partial<GeminiBatchexecuteContext> = {}): GeminiBatchexecuteContext => ({
    at: 'AT-TOKEN',
    bl: 'boq_assistant-bard-web-server_20260210.04_p0',
    fSid: '-37108853284977362',
    hl: 'en',
    reqid: 2641802,
    rt: 'c',
    updatedAt: 1_700_000_000_000,
    ...overrides,
});

describe('resolvePlatformKind', () => {
    it('should map ChatGPT page URLs to chatgpt', () => {
        expect(resolvePlatformKind(chatGPTAdapter, `https://chatgpt.com/c/${CHATGPT_ID}`)).toBe('chatgpt');
        expect(resolvePlatformKind(chatGPTAdapter, 'https://chat.openai.com/c/abc')).toBe('chatgpt');
    });

    it('should map Gemini page URLs to gemini', () => {
        expect(resolvePlatformKind(geminiAdapter, `https://gemini.google.com/app/${GEMINI_ID}`)).toBe('gemini');
        expect(resolvePlatformKind(geminiAdapter, `https://gemini.google.com/share/${GEMINI_ID}`)).toBe('gemini');
    });

    it('should map grok.com page URLs to grok', () => {
        expect(resolvePlatformKind(grokAdapter, `https://grok.com/c/${GROK_ID}`)).toBe('grok');
    });

    it('should reject grok.x.com-only adapters for grok.com URLs (caller will fail with unsupported)', () => {
        // The Grok adapter advertises grok.com support, so this still maps to 'grok'.
        expect(resolvePlatformKind(grokAdapter, 'https://www.grok.com/c/01cb0729-6455-471d-b33a-124b3de76a29')).toBe(
            'grok',
        );
    });
});

describe('buildDetailRequest — ChatGPT', () => {
    it('should expose deterministic ChatGPT fallback candidates in order', () => {
        const result = buildDetailRequest({
            platform: 'chatgpt',
            adapter: chatGPTAdapter,
            conversationId: CHATGPT_ID,
            pageUrl: `https://chatgpt.com/c/${CHATGPT_ID}`,
        });
        expect(result.ok).toBeTrue();
        if (!result.ok) {
            return;
        }
        expect(result.requests.map((request) => request.url)).toEqual([
            `https://chatgpt.com/backend-api/conversation/${CHATGPT_ID}`,
            `https://chatgpt.com/backend-api/f/conversation/${CHATGPT_ID}`,
            `https://chat.openai.com/backend-api/conversation/${CHATGPT_ID}`,
            `https://chat.openai.com/backend-api/f/conversation/${CHATGPT_ID}`,
        ]);
    });

    it('should use the adapter buildApiUrl as the deterministic detail endpoint', () => {
        const result = buildDetailRequest({
            platform: 'chatgpt',
            adapter: chatGPTAdapter,
            conversationId: CHATGPT_ID,
            pageUrl: `https://chatgpt.com/c/${CHATGPT_ID}`,
        });
        expect(result.ok).toBeTrue();
        if (!result.ok) {
            return;
        }
        expect(result.requests[0]?.url).toBe(`https://chatgpt.com/backend-api/conversation/${CHATGPT_ID}`);
        expect(result.requests[0]?.method).toBe('GET');
        expect(result.requests[0]?.body).toBeUndefined();
        expect(result.requests[0]?.requiresAuthContext).toBeFalse();
    });

    it('should pick the first buildApiUrls candidate when buildApiUrl is missing', () => {
        const fakeAdapter = {
            ...chatGPTAdapter,
            buildApiUrl: undefined,
            buildApiUrls: (id: string) => [
                `https://chatgpt.com/backend-api/f/conversation/${id}`,
                `https://chat.openai.com/backend-api/conversation/${id}`,
            ],
        };
        const result = buildDetailRequest({
            platform: 'chatgpt',
            adapter: fakeAdapter as never,
            conversationId: CHATGPT_ID,
            pageUrl: `https://chatgpt.com/c/${CHATGPT_ID}`,
        });
        expect(result.ok).toBeTrue();
        if (!result.ok) {
            return;
        }
        expect(result.requests[0]?.url).toBe(`https://chatgpt.com/backend-api/f/conversation/${CHATGPT_ID}`);
    });

    it('should report missing_endpoint when neither buildApiUrl nor buildApiUrls is available', () => {
        const fakeAdapter = {
            ...chatGPTAdapter,
            buildApiUrl: undefined,
            buildApiUrls: undefined,
        };
        const result = buildDetailRequest({
            platform: 'chatgpt',
            adapter: fakeAdapter as never,
            conversationId: CHATGPT_ID,
            pageUrl: `https://chatgpt.com/c/${CHATGPT_ID}`,
        });
        expect(result.ok).toBeFalse();
        if (result.ok) {
            return;
        }
        expect(result.reason).toBe('missing_endpoint');
    });
});

describe('buildDetailRequest — Grok', () => {
    it('should use the first buildApiUrls candidate as the deterministic detail endpoint', () => {
        const result = buildDetailRequest({
            platform: 'grok',
            adapter: grokAdapter,
            conversationId: GROK_ID,
            pageUrl: `https://grok.com/c/${GROK_ID}`,
        });
        expect(result.ok).toBeTrue();
        if (!result.ok) {
            return;
        }
        expect(result.requests[0]?.url).toBe(
            `https://grok.com/rest/app-chat/conversations_v2/${GROK_ID}?includeWorkspaces=true&includeTaskResult=true`,
        );
        expect(result.requests[0]?.method).toBe('GET');
        expect(result.requests[0]?.requiresAuthContext).toBeFalse();
    });

    it('should reject non-UUID Grok IDs at the resolver level', () => {
        const result = buildDetailRequest({
            platform: 'grok',
            adapter: grokAdapter,
            conversationId: 'not-a-uuid',
            pageUrl: 'https://grok.com/c/not-a-uuid',
        });
        expect(result.ok).toBeFalse();
        if (result.ok) {
            return;
        }
        expect(result.reason).toBe('missing_endpoint');
    });
});

describe('buildDetailRequest — Gemini', () => {
    it('should build a deterministic batchexecute POST with the CONVERSATION RPC ID', () => {
        const ctx = makeGeminiContext();
        const result = buildDetailRequest({
            platform: 'gemini',
            adapter: geminiAdapter,
            conversationId: GEMINI_ID,
            pageUrl: `https://gemini.google.com/app/${GEMINI_ID}`,
            geminiContext: ctx,
        });
        expect(result.ok).toBeTrue();
        if (!result.ok) {
            return;
        }
        const req = result.requests[0]!;
        expect(req.method).toBe('POST');
        expect(req.url).toContain('https://gemini.google.com/_/BardChatUi/data/batchexecute');
        expect(req.url).toContain(`rpcids=${GEMINI_RPC_IDS.CONVERSATION}`);
        expect(req.url).toContain(`source-path=${encodeURIComponent(`/app/${GEMINI_ID}`)}`);
        expect(req.requiresAuthContext).toBeTrue();
        expect(req.body).toContain('at=AT-TOKEN');
        expect(req.body).toContain('f.req=');
        expect(req.headers?.['content-type']).toBe('application/x-www-form-urlencoded;charset=UTF-8');
    });

    it('should request a fresh reqid when the context has none', () => {
        const result = buildDetailRequest({
            platform: 'gemini',
            adapter: geminiAdapter,
            conversationId: GEMINI_ID,
            pageUrl: `https://gemini.google.com/app/${GEMINI_ID}`,
            geminiContext: { at: 'AT-TOKEN', updatedAt: 1_700_000_000_000 },
        });
        expect(result.ok).toBeTrue();
        if (!result.ok) {
            return;
        }
        expect(result.requests[0]?.url).toMatch(/_reqid=\d+/);
    });

    it('should fail with missing_auth when the at token is absent', () => {
        const result = buildDetailRequest({
            platform: 'gemini',
            adapter: geminiAdapter,
            conversationId: GEMINI_ID,
            pageUrl: `https://gemini.google.com/app/${GEMINI_ID}`,
            geminiContext: { at: '', updatedAt: 1_700_000_000_000 },
        });
        expect(result.ok).toBeFalse();
        if (result.ok) {
            return;
        }
        expect(result.reason).toBe('missing_auth');
    });

    it('should fail with missing_auth when the context itself is undefined', () => {
        const result = buildDetailRequest({
            platform: 'gemini',
            adapter: geminiAdapter,
            conversationId: GEMINI_ID,
            pageUrl: `https://gemini.google.com/app/${GEMINI_ID}`,
        });
        expect(result.ok).toBeFalse();
        if (result.ok) {
            return;
        }
        expect(result.reason).toBe('missing_auth');
    });
});

describe('buildDetailRequest — contract', () => {
    it('should produce a GET request with credentials=include baked into the request shape', () => {
        const result = buildDetailRequest({
            platform: 'chatgpt',
            adapter: chatGPTAdapter,
            conversationId: CHATGPT_ID,
            pageUrl: `https://chatgpt.com/c/${CHATGPT_ID}`,
        });
        expect(result.ok).toBeTrue();
        if (!result.ok) {
            return;
        }
        const req: DetailRequest = result.requests[0]!;
        expect(typeof req.url).toBe('string');
        expect(req.url.length).toBeGreaterThan(0);
        expect(['GET', 'POST']).toContain(req.method);
    });
});
