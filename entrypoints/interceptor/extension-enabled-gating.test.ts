import { describe, expect, it, mock } from 'bun:test';
import { handleFetchInterception } from '@/entrypoints/interceptor/fetch-interception';
import { handleXhrLoad } from '@/entrypoints/interceptor/xhr-interception';

describe('extension enabled gating', () => {
    it('should suppress fetch interception side effects when disabled', async () => {
        const emitter = {
            log: mock(() => {}),
            shouldLogTransient: mock(() => true),
            shouldEmitCapturedPayload: mock(() => true),
            emitApiResponseDumpFrame: mock(() => {}),
            emitCapturePayload: mock(() => {}),
            emitStreamDelta: mock(() => {}),
            emitStreamDumpFrame: mock(() => {}),
            emitResponseFinished: mock(() => {}),
        } as any;

        handleFetchInterception(
            [
                'https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=MaZiqc',
                {
                    method: 'POST',
                    body: 'ignored',
                },
            ] as unknown as Parameters<typeof fetch>,
            new Response('ignored', { status: 200 }),
            {
                emitter,
                resolveAttemptIdForConversation: mock(() => 'attempt-1'),
                isExtensionEnabled: () => false,
            } as any,
        );

        await Promise.resolve();
        expect(emitter.log).not.toHaveBeenCalled();
        expect(emitter.emitResponseFinished).not.toHaveBeenCalled();
        expect(emitter.emitCapturePayload).not.toHaveBeenCalled();
    });

    it('should suppress xhr interception side effects when disabled', () => {
        const emitter = {
            log: mock(() => {}),
            shouldLogTransient: mock(() => true),
            emitApiResponseDumpFrame: mock(() => {}),
            emitCapturePayload: mock(() => {}),
            emitStreamDelta: mock(() => {}),
            emitStreamDumpFrame: mock(() => {}),
            emitResponseFinished: mock(() => {}),
        } as any;

        handleXhrLoad({ responseText: 'ignored', status: 200 } as any, 'POST', {
            emitter,
            resolveAttemptIdForConversation: mock(() => 'attempt-1'),
            proactiveFetchRunner: { trigger: mock(() => Promise.resolve()) } as any,
            isExtensionEnabled: () => false,
        } as any);

        expect(emitter.log).not.toHaveBeenCalled();
        expect(emitter.emitResponseFinished).not.toHaveBeenCalled();
        expect(emitter.emitCapturePayload).not.toHaveBeenCalled();
    });
});
