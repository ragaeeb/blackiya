import { describe, expect, it } from 'bun:test';
import { ProactiveFetcher } from '@/entrypoints/interceptor/proactive-fetcher';

describe('ProactiveFetcher', () => {
    it('tracks in-flight keys without duplicates', () => {
        const fetcher = new ProactiveFetcher();
        expect(fetcher.markInFlight('conv-1')).toBe(true);
        expect(fetcher.markInFlight('conv-1')).toBe(false);
        fetcher.clearInFlight('conv-1');
        expect(fetcher.markInFlight('conv-1')).toBe(true);
    });
});
