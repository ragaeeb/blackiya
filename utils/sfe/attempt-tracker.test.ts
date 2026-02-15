import { describe, expect, it } from 'bun:test';
import { AttemptTracker } from '@/utils/sfe/attempt-tracker';

describe('AttemptTracker', () => {
    it('creates and returns same attempt for duplicate ID', () => {
        const tracker = new AttemptTracker();
        const first = tracker.create({ attemptId: 'a1', platform: 'ChatGPT' });
        const second = tracker.create({ attemptId: 'a1', platform: 'ChatGPT' });
        expect(first).toBe(second);
        expect(tracker.size()).toBe(1);
    });

    it('supersedes previous active attempt for same conversation', () => {
        const tracker = new AttemptTracker();
        tracker.create({ attemptId: 'a1', platform: 'ChatGPT', conversationId: 'c1' });
        tracker.create({ attemptId: 'a2', platform: 'ChatGPT', conversationId: 'c1' });

        const a1 = tracker.get('a1');
        const active = tracker.getActiveByConversationId('c1');
        expect(a1?.phase).toBe('superseded');
        expect(active[0]?.attemptId).toBe('a2');
    });

    it('disposes attempts and clears active mapping', () => {
        const tracker = new AttemptTracker();
        tracker.create({ attemptId: 'a1', platform: 'ChatGPT', conversationId: 'c1' });
        tracker.dispose('a1');
        expect(tracker.get('a1')?.phase).toBe('disposed');
        expect(tracker.getActiveByConversationId('c1').length).toBe(0);
    });

    it('disposes active in-flight attempts on route change', () => {
        const tracker = new AttemptTracker();
        tracker.create({ attemptId: 'a1', platform: 'ChatGPT', phase: 'streaming' });
        tracker.create({ attemptId: 'a2', platform: 'ChatGPT', phase: 'captured_ready' });
        const disposed = tracker.disposeAllForRouteChange();
        expect(disposed).toContain('a1');
        expect(disposed).not.toContain('a2');
    });

    it('evicts completed attempts after TTL', () => {
        let now = 1000;
        const tracker = new AttemptTracker({
            completedAttemptTtlMs: 200,
            now: () => now,
        });

        tracker.create({ attemptId: 'a1', platform: 'ChatGPT', phase: 'captured_ready', timestampMs: now });
        expect(tracker.get('a1')).toBeDefined();

        now = 1301;
        tracker.create({ attemptId: 'a2', platform: 'ChatGPT', phase: 'prompt_sent', timestampMs: now });
        expect(tracker.get('a1')).toBeUndefined();
    });
});
