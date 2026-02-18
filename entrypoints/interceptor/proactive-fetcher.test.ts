import { describe, expect, it } from 'bun:test';
import { ProactiveFetcher } from '@/entrypoints/interceptor/proactive-fetcher';

describe('ProactiveFetcher', () => {
    it('tracks in-flight keys without duplicates', () => {
        const fetcher = new ProactiveFetcher();
        expect(fetcher.markInFlight('conv-1')).toBeTrue();
        expect(fetcher.markInFlight('conv-1')).toBeFalse();
        fetcher.clearInFlight('conv-1');
        expect(fetcher.markInFlight('conv-1')).toBeTrue();
    });

    it('withInFlight clears key in finally and returns callback result', async () => {
        const fetcher = new ProactiveFetcher();
        const result = await fetcher.withInFlight('conv-2', async () => {
            expect(fetcher.markInFlight('conv-2')).toBeFalse();
            return 'ok';
        });
        expect(result).toBe('ok');
        expect(fetcher.markInFlight('conv-2')).toBeTrue();
    });

    it('withInFlight returns undefined when key is already in-flight', async () => {
        const fetcher = new ProactiveFetcher();
        expect(fetcher.markInFlight('conv-3')).toBeTrue();
        const result = await fetcher.withInFlight('conv-3', async () => true);
        expect(result).toBeUndefined();
    });

    it('withInFlight clears key even when callback throws', async () => {
        const fetcher = new ProactiveFetcher();
        await expect(
            fetcher.withInFlight('conv-err', async () => {
                throw new Error('boom');
            }),
        ).rejects.toThrow('boom');
        expect(fetcher.markInFlight('conv-err')).toBeTrue();
    });

    it('bounds in-flight keys by evicting oldest entry when capacity is exceeded', () => {
        let now = 1_000;
        const fetcher = new ProactiveFetcher({
            maxInFlight: 2,
            now: () => now,
        });
        expect(fetcher.markInFlight('a')).toBeTrue();
        now += 100;
        expect(fetcher.markInFlight('b')).toBeTrue();
        now += 100;
        expect(fetcher.markInFlight('c')).toBeTrue();
        // 'a' is the oldest and should be evicted to keep the set bounded.
        expect(fetcher.markInFlight('a')).toBeTrue();
    });
});
