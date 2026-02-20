import { describe, expect, it } from 'bun:test';
import { appendStreamProbePreview } from '@/utils/runner/stream-probe';

describe('stream-probe', () => {
    describe('appendStreamProbePreview', () => {
        it('should merge strings without truncation if under max length', () => {
            expect(appendStreamProbePreview('hello ', 'world', 50)).toBe('hello world');
        });

        it('should truncate and prepend ellipsis if over max length', () => {
            expect(appendStreamProbePreview('this is a very long string', ' indeed', 10)).toBe('... indeed');
        });

        it('should truncate correctly if max length is very small (<=3)', () => {
            expect(appendStreamProbePreview('string', ' end', 3)).toBe('end');
        });
    });
});
