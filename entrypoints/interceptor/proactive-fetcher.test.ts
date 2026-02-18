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

    it('withInFlight clears key in finally and returns callback result', async () => {
        const fetcher = new ProactiveFetcher();
        const result = await fetcher.withInFlight('conv-2', async () => {
            expect(fetcher.markInFlight('conv-2')).toBe(false);
            return 'ok';
        });
        expect(result).toBe('ok');
        expect(fetcher.markInFlight('conv-2')).toBe(true);
    });

    it('withInFlight returns undefined when key is already in-flight', async () => {
        const fetcher = new ProactiveFetcher();
        expect(fetcher.markInFlight('conv-3')).toBe(true);
        const result = await fetcher.withInFlight('conv-3', async () => true);
        expect(result).toBeUndefined();
    });
});
