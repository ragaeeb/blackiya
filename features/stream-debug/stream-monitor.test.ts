import { describe, expect, it } from 'bun:test';
import { createStreamDebugRecorder } from '@/features/stream-debug/recorder';
import { monitorFetchResponse } from '@/features/stream-debug/stream-monitor';

const responseFromChunks = (
    chunks: string[],
    onStart?: (controller: ReadableStreamDefaultController<Uint8Array>) => void,
) => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            onStart?.(controller);
            for (const chunk of chunks) {
                controller.enqueue(encoder.encode(chunk));
            }
            if (onStart === undefined) {
                controller.close();
            }
        },
    });
    return new Response(body, { status: 200 });
};

describe('stream-debug fetch monitor', () => {
    it('should reassemble ordered frames across split fetch chunks and retain [DONE]', async () => {
        const recorder = createStreamDebugRecorder();
        const streamId = recorder.startStream({
            streamId: 'stream-fetch-1',
            platform: 'ChatGPT',
            endpoint: 'generation',
            method: 'POST',
            url: '/backend-api/f/conversation',
        });
        const response = responseFromChunks([
            'data: refusal\n\ndata: repl',
            'acement\n\ndata: erase\n\ndata: [DO',
            'NE]\n\n',
        ]);

        await monitorFetchResponse(response.clone(), streamId, recorder, { framing: 'sse' });

        expect(await response.text()).toBe('data: refusal\n\ndata: replacement\n\ndata: erase\n\ndata: [DONE]\n\n');
        const [record] = recorder.exportRecords();
        expect(
            record?.frames
                .filter((frame) => frame.kind !== 'transport')
                .map((frame) => ({ kind: frame.kind, event: frame.event, text: frame.text })),
        ).toEqual([
            { kind: 'refusal', event: 'refusal', text: 'data: refusal' },
            { kind: 'replacement', event: 'replacement', text: 'data: replacement' },
            { kind: 'erase', event: 'erase', text: 'data: erase' },
            { kind: 'done', event: 'done', text: 'data: [DONE]' },
        ]);
        expect(record?.status).toBe('closed');
    });

    it('should retain late refusal, replacement, erase, and done frames through recorder bounds', async () => {
        const recorder = createStreamDebugRecorder({
            maxFramesPerStream: 4,
            maxStreamBytes: 80,
            maxFrameBytes: 80,
        });
        const streamId = recorder.startStream({
            streamId: 'stream-fetch-late-signals',
            platform: 'ChatGPT',
            endpoint: 'generation',
            method: 'POST',
            url: '/backend-api/f/conversation',
        });
        const response = responseFromChunks([
            'data: ordinary-1\n\ndata: ordinary-2\n\ndata: ordinary-3\n\ndata: ordinary-4\n\n',
            'data: refusal\n\ndata: replacement\n\ndata: erase\n\ndata: [DONE]\n\n',
        ]);

        await monitorFetchResponse(response, streamId, recorder, { framing: 'sse' });

        const record = recorder.getStream(streamId);
        expect(record?.frames.filter((frame) => frame.kind !== 'transport').map((frame) => frame.kind)).toEqual([
            'refusal',
            'replacement',
            'erase',
            'done',
        ]);
        expect(record?.frames.filter((frame) => frame.kind !== 'transport').map((frame) => frame.event)).toEqual([
            'refusal',
            'replacement',
            'erase',
            'done',
        ]);
        expect(record?.totalByteLength).toBeLessThanOrEqual(80);
        expect(record?.droppedFrameCount).toBeGreaterThan(0);
    });

    it('should keep monitoring state bounded for a long unterminated body', async () => {
        const recorder = createStreamDebugRecorder({
            maxFrameBytes: 4096,
            maxStreamBytes: 16_384,
        });
        const streamId = recorder.startStream({
            streamId: 'stream-long-body',
            platform: 'Gemini',
            endpoint: 'generation',
            method: 'POST',
            url: '/streamgenerate',
        });
        const response = responseFromChunks(['x'.repeat(200_000)]);

        await monitorFetchResponse(response.clone(), streamId, recorder, { framing: 'line' });

        const record = recorder.getStream(streamId);
        expect(record?.status).toBe('closed');
        expect(record?.totalRawBytes).toBe(200_000);
        expect(record?.totalByteLength).toBeLessThanOrEqual(16_384);
        expect(record?.frames.length).toBeGreaterThan(1);
        expect(record?.frames.every((frame) => frame.storedByteLength <= 4096)).toBeTrue();
        expect(record?.frames.every((frame) => frame.text.length <= 4096)).toBeTrue();
    });

    it('should leave the page-owned response readable when monitoring a clone', async () => {
        const recorder = createStreamDebugRecorder();
        const streamId = recorder.startStream({
            streamId: 'stream-fetch-clone',
            platform: 'ChatGPT',
            endpoint: 'generation',
            method: 'POST',
            url: '/backend-api/f/conversation',
        });
        const response = responseFromChunks(['data: refusal\n\n', 'data: [DONE]\n\n']);

        await monitorFetchResponse(response.clone(), streamId, recorder, { framing: 'sse' });

        expect(await response.text()).toBe('data: refusal\n\ndata: [DONE]\n\n');
        expect(recorder.exportRecords()[0]?.status).toBe('closed');
    });

    it('should retain clean close, abort, and error transport events', async () => {
        const makeRecorder = (id: string) => {
            const recorder = createStreamDebugRecorder();
            const streamId = recorder.startStream({
                streamId: id,
                platform: 'Grok',
                endpoint: 'generation',
                method: 'POST',
                url: '/stream',
            });
            return { recorder, streamId };
        };

        const clean = makeRecorder('stream-close');
        await monitorFetchResponse(responseFromChunks(['line\n']), clean.streamId, clean.recorder, { framing: 'line' });
        expect(clean.recorder.exportRecords()[0]?.status).toBe('closed');

        const abort = makeRecorder('stream-abort');
        const abortController = new AbortController();
        const abortResponse = responseFromChunks([], (controller) => {
            abortController.signal.addEventListener('abort', () => {
                controller.error(new DOMException('aborted', 'AbortError'));
            });
        });
        const abortPromise = monitorFetchResponse(abortResponse, abort.streamId, abort.recorder, {
            framing: 'raw',
            signal: abortController.signal,
        });
        abortController.abort();
        await abortPromise;
        expect(abort.recorder.exportRecords()[0]?.status).toBe('aborted');

        const error = makeRecorder('stream-error');
        const errorResponse = responseFromChunks([], (controller) => {
            controller.error(new Error('transport failed'));
        });
        await monitorFetchResponse(errorResponse, error.streamId, error.recorder, { framing: 'raw' });
        expect(error.recorder.exportRecords()[0]?.status).toBe('error');
    });

    it('should cancel a pending reader when the monitor signal aborts', async () => {
        const recorder = createStreamDebugRecorder();
        const streamId = recorder.startStream({
            streamId: 'stream-pending-abort',
            platform: 'ChatGPT',
            endpoint: 'generation',
            method: 'POST',
            url: '/stream',
        });
        const abortController = new AbortController();
        let canceled = false;
        const response = new Response(
            new ReadableStream<Uint8Array>({
                cancel() {
                    canceled = true;
                },
            }),
        );
        const monitoring = monitorFetchResponse(response, streamId, recorder, {
            framing: 'raw',
            signal: abortController.signal,
        });

        abortController.abort();
        await expect(
            Promise.race([
                monitoring,
                new Promise((_, reject) => setTimeout(() => reject(new Error('monitor did not settle')), 100)),
            ]),
        ).resolves.toBeUndefined();
        expect(canceled).toBeTrue();
        expect(recorder.getStream(streamId)?.status).toBe('aborted');
    });

    it('should terminate an empty response instead of leaving it active', async () => {
        const recorder = createStreamDebugRecorder();
        const streamId = recorder.startStream({
            streamId: 'stream-empty-response',
            platform: 'ChatGPT',
            endpoint: 'generation',
            method: 'POST',
            url: '/backend-api/f/conversation',
        });

        await monitorFetchResponse(new Response(null, { status: 204 }), streamId, recorder, { framing: 'sse' });

        expect(recorder.getStream(streamId)?.status).toBe('closed');
        expect(recorder.getStream(streamId)?.termination?.event).toBe('close');
    });
});
