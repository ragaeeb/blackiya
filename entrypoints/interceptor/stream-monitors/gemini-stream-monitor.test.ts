import { describe, expect, it } from 'bun:test';
import { shouldProcessGeminiChunk } from '@/entrypoints/interceptor/stream-monitors/gemini-stream-monitor';

describe('gemini-stream-monitor', () => {
    it('ignores empty chunks and processes non-empty chunks', () => {
        expect(shouldProcessGeminiChunk('   ')).toBeFalse();
        expect(shouldProcessGeminiChunk('token')).toBeTrue();
    });
});
