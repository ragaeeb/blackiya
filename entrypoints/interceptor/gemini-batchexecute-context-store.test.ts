import { describe, expect, it } from 'bun:test';
import {
    getGeminiBatchexecuteContext,
    maybeCaptureGeminiBatchexecuteContext,
    resetGeminiBatchexecuteContext,
} from '@/entrypoints/interceptor/gemini-batchexecute-context-store';

describe('gemini-batchexecute-context-store', () => {
    it('should capture query and body context from gemini batchexecute request', () => {
        resetGeminiBatchexecuteContext();
        maybeCaptureGeminiBatchexecuteContext(
            'https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=hNvQHb&source-path=%2Fapp%2Fabc&bl=boq&f.sid=123&hl=en&_reqid=42&rt=c',
            'f.req=%5B%5D&at=AJvTest%3A1&',
        );

        const context = getGeminiBatchexecuteContext();
        expect(context?.bl).toBe('boq');
        expect(context?.fSid).toBe('123');
        expect(context?.hl).toBe('en');
        expect(context?.rt).toBe('c');
        expect(context?.reqid).toBe(42);
        expect(context?.at).toBe('AJvTest:1');
    });

    it('should ignore non-batchexecute urls', () => {
        resetGeminiBatchexecuteContext();
        maybeCaptureGeminiBatchexecuteContext('https://gemini.google.com/app/abc', 'f.req=%5B%5D&at=AJvTest%3A1&');
        expect(getGeminiBatchexecuteContext()).toBeUndefined();
    });
});
