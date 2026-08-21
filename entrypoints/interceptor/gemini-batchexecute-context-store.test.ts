import { describe, expect, it } from 'bun:test';
import {
    GEMINI_BATCHEXECUTE_CONTEXT_MAX_AGE_MS,
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

    it('should replace the complete context instead of carrying fields across sessions', () => {
        resetGeminiBatchexecuteContext();
        maybeCaptureGeminiBatchexecuteContext(
            'https://gemini.google.com/_/BardChatUi/data/batchexecute?bl=old&f.sid=old&hl=en&_reqid=1&rt=c',
            'at=OLD-TOKEN',
            1_000,
        );
        maybeCaptureGeminiBatchexecuteContext(
            'https://gemini.google.com/_/BardChatUi/data/batchexecute?bl=new&hl=fr&_reqid=2&rt=c',
            'at=NEW-TOKEN',
            2_000,
        );

        expect(getGeminiBatchexecuteContext(2_000)).toEqual({
            bl: 'new',
            hl: 'fr',
            rt: 'c',
            reqid: 2,
            at: 'NEW-TOKEN',
            updatedAt: 2_000,
        });
    });

    it('should invalidate a prior token when the newest context has no usable token', () => {
        resetGeminiBatchexecuteContext();
        maybeCaptureGeminiBatchexecuteContext(
            'https://gemini.google.com/_/BardChatUi/data/batchexecute?bl=old&f.sid=old&_reqid=1&rt=c',
            'at=OLD-TOKEN',
            1_000,
        );
        maybeCaptureGeminiBatchexecuteContext(
            'https://gemini.google.com/_/BardChatUi/data/batchexecute?bl=new&_reqid=2&rt=c',
            'at=%20%20%20',
            2_000,
        );

        expect(getGeminiBatchexecuteContext(2_000)).toEqual({
            bl: 'new',
            rt: 'c',
            reqid: 2,
            updatedAt: 2_000,
        });
    });

    it('should reject an expired context and return defensive snapshots', () => {
        resetGeminiBatchexecuteContext();
        maybeCaptureGeminiBatchexecuteContext(
            'https://gemini.google.com/_/BardChatUi/data/batchexecute?bl=boq&_reqid=42&rt=c',
            'at=AT-TOKEN',
            1_000,
        );

        const snapshot = getGeminiBatchexecuteContext(1_000);
        expect(snapshot).toBeDefined();
        snapshot!.at = 'LEAKED-MUTATION';
        expect(getGeminiBatchexecuteContext(1_000)?.at).toBe('AT-TOKEN');
        expect(getGeminiBatchexecuteContext(1_000 + GEMINI_BATCHEXECUTE_CONTEXT_MAX_AGE_MS)).toBeUndefined();
    });
});
