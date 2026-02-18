import { describe, expect, it } from 'bun:test';
import { normalizeGrokStreamChunk } from '@/entrypoints/interceptor/stream-monitors/grok-stream-monitor';

describe('grok-stream-monitor', () => {
    it('normalizes CRLF line endings', () => {
        expect(normalizeGrokStreamChunk('a\r\nb')).toBe('a\nb');
    });
});
