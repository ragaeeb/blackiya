import { describe, expect, it } from 'bun:test';

import { extractLikelyTextFromSsePayload } from './text-extraction';

describe('text-extraction', () => {
    it('should not let preferred-key recursion duplicates exhaust candidate collection', () => {
        const payload: Record<string, unknown> = {
            content: Array.from({ length: 60 }, (_, i) => `preferred-${i}`),
        };
        for (let i = 0; i < 30; i++) {
            payload[`tail_${i}`] = `tail-${i}`;
        }

        const values = extractLikelyTextFromSsePayload(JSON.stringify(payload));
        expect(values).toContain('preferred-0');
        expect(values).toContain('tail-0');
    });
});
