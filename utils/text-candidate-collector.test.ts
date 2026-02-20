import { describe, expect, it } from 'bun:test';
import { collectLikelyTextCandidates } from '@/utils/text-candidate-collector';

describe('text-candidate-collector', () => {
    it('should collect text from preferred keys before scanning fallback keys', () => {
        const candidates = collectLikelyTextCandidates(
            {
                ignored: 'ignore me',
                payload: {
                    message: 'Preferred text',
                    random: 'Fallback text',
                },
            },
            {
                preferredKeys: ['message'],
                isLikelyText: (value) => value.includes('text') || value.includes('Preferred'),
            },
        );

        expect(candidates).toEqual(['Preferred text', 'Fallback text']);
    });

    it('should skip configured keys', () => {
        const candidates = collectLikelyTextCandidates(
            {
                token: 'skip this token',
                message: 'keep this message',
            },
            {
                preferredKeys: ['message'],
                skipKeys: new Set(['token']),
                isLikelyText: () => true,
            },
        );

        expect(candidates).toEqual(['keep this message']);
    });

    it('should respect depth and max-candidate limits', () => {
        const nested = { a: { b: { c: { d: { e: { f: { g: { h: { i: 'too deep' } } } } } } } } };
        const candidates = collectLikelyTextCandidates(nested, {
            maxDepth: 4,
            maxCandidates: 1,
            isLikelyText: () => true,
        });

        expect(candidates).toEqual([]);
    });

    it('should apply normalize callback before likelihood checks', () => {
        const candidates = collectLikelyTextCandidates(
            {
                message: '  Normalized Text  ',
            },
            {
                preferredKeys: ['message'],
                normalize: (value) => value.replace(/\s+/g, ' '),
                isLikelyText: (value) => value.includes('Normalized'),
            },
        );

        expect(candidates).toEqual(['Normalized Text']);
    });

    it('should preserve outer whitespace when configured', () => {
        const candidates = collectLikelyTextCandidates(
            {
                message: 'Word ',
            },
            {
                preferredKeys: ['message'],
                preserveWhitespace: true,
                isLikelyText: () => true,
            },
        );

        expect(candidates).toEqual(['Word ']);
    });

    it('should skip entries with shouldSkipEntry predicate', () => {
        const candidates = collectLikelyTextCandidates(
            {
                message: 'keep',
                token: 'skip',
                isThinking: true,
            },
            {
                isLikelyText: () => true,
                shouldSkipEntry: ({ key, parent }) => key === 'token' && parent.isThinking === true,
            },
        );

        expect(candidates).toEqual(['keep']);
    });
});
