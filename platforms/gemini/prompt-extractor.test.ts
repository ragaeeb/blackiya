import { describe, expect, it, mock } from 'bun:test';

mock.module('@/utils/logger', () => ({
    logger: { info: mock(() => {}), warn: mock(() => {}), error: mock(() => {}), debug: mock(() => {}) },
}));

import { extractGeminiPromptFromXhrBody } from './prompt-extractor';

/** Build a realistic Gemini StreamGenerate f.req body for a first-turn prompt */
const buildFReq = (userText: string): string => {
    // Mirrors the real StreamGenerate POST body shape: payload[2][0][0][0] = userText
    const payload = [null, null, [[[userText, 'user', null, null, null, null, null, null, []]]]];
    return `f.req=${encodeURIComponent(JSON.stringify(payload))}&`;
};

/** Build a body where slot [2][0][0] is not a plain array (tests fallback path) */
const buildFReqNestedDifferently = (userText: string): string => {
    const payload = [null, null, [[{ text: userText }]]];
    return `f.req=${encodeURIComponent(JSON.stringify(payload))}`;
};

describe('extractGeminiPromptFromXhrBody', () => {
    it('should extract prompt from known slot path [2][0][0][0]', () => {
        const body = buildFReq("What is Mu'jam of al-Tabarani?");
        const result = extractGeminiPromptFromXhrBody(body);
        expect(result).toBe("What is Mu'jam of al-Tabarani?");
    });

    it('should trim whitespace from the extracted prompt', () => {
        const payload = [null, null, [[[' What is Islam? ', 'user']]]];
        const body = `f.req=${encodeURIComponent(JSON.stringify(payload))}`;
        const result = extractGeminiPromptFromXhrBody(body);
        expect(result).toBe('What is Islam?');
    });

    it('should return null for null or empty body', () => {
        expect(extractGeminiPromptFromXhrBody(null)).toBeNull();
        expect(extractGeminiPromptFromXhrBody(undefined)).toBeNull();
        expect(extractGeminiPromptFromXhrBody('')).toBeNull();
    });

    it('should return null when f.req param is missing', () => {
        const body = 'at=abc123&other=value';
        expect(extractGeminiPromptFromXhrBody(body)).toBeNull();
    });

    it('should return null when f.req is not valid JSON', () => {
        const body = 'f.req=not-valid-json';
        expect(extractGeminiPromptFromXhrBody(body)).toBeNull();
    });

    it('should return null when the user slot [2] is absent', () => {
        const payload = [null, null];
        const body = `f.req=${encodeURIComponent(JSON.stringify(payload))}`;
        expect(extractGeminiPromptFromXhrBody(body)).toBeNull();
    });

    it('should return null for strings shorter than minimum prompt length', () => {
        const payload = [null, null, [[['Hi']]]]; // 'Hi' = 2 chars, below MIN (3)
        const body = `f.req=${encodeURIComponent(JSON.stringify(payload))}`;
        expect(extractGeminiPromptFromXhrBody(body)).toBeNull();
    });

    it('should fall back to depth scan when known slot path has unexpected structure', () => {
        const body = buildFReqNestedDifferently('Explain hadith sciences');
        // Known path fails (slot200 is an object not an array), fallback finds the string
        const result = extractGeminiPromptFromXhrBody(body);
        // Fallback DFS won't find it inside an object (only scans arrays), returns null
        expect(result).toBeNull();
    });

    it('should fall back to depth scan when f.req has shifted indices', () => {
        // Variant: user text at [2][0][0][0] but slot [2][0] is one extra level deep
        const userText = 'What are the five pillars of Islam?';
        const payload = ['metadata', null, [[[userText]]]];
        const body = `f.req=${encodeURIComponent(JSON.stringify(payload))}`;
        const result = extractGeminiPromptFromXhrBody(body);
        expect(result).toBe(userText);
    });

    it('should handle multi-line prompts correctly', () => {
        const userText = 'Line one\nLine two\nLine three';
        const payload = [null, null, [[[userText]]]];
        const body = `f.req=${encodeURIComponent(JSON.stringify(payload))}`;
        const result = extractGeminiPromptFromXhrBody(body);
        expect(result).toBe(userText);
    });

    it('should handle a body with both f.req and other params', () => {
        const payload = [null, null, [[['What is Tawhid?']]]];
        const body = `at=XYZ&f.req=${encodeURIComponent(JSON.stringify(payload))}&bl=boq`;
        const result = extractGeminiPromptFromXhrBody(body);
        expect(result).toBe('What is Tawhid?');
    });
});
