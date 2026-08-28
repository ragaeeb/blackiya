import { describe, expect, it } from 'bun:test';
import { createStreamDebugRecorder } from '@/features/stream-debug/recorder';
import { createMonitoredFetchResponse, extractSseFrames } from '@/features/stream-debug/stream-monitor';

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
    it('should split SSE frames across CR, LF, CRLF, and mixed blank lines', () => {
        expect(extractSseFrames('data: one\r\rdata: two\r\n\ndata: three\n\rdata: four\r\n\r\n')).toEqual({
            frames: ['data: one', 'data: two', 'data: three', 'data: four'],
            remainder: '',
        });
    });

    it('should observe bytes only as the page consumes the pass-through response and preserve metadata', async () => {
        const recorder = createStreamDebugRecorder();
        const streamId = recorder.startStream({
            streamId: 'stream-demand-coupled',
            platform: 'ChatGPT',
            endpoint: 'generation',
            method: 'POST',
            url: '/backend-api/f/conversation',
        });
        const encoder = new TextEncoder();
        const chunks = [encoder.encode('data: refusal\n\n'), encoder.encode('data: [DONE]\n\n')];
        let pullCount = 0;
        const source = new ReadableStream<Uint8Array>(
            {
                pull(controller) {
                    pullCount += 1;
                    const chunk = chunks.shift();
                    if (chunk) {
                        controller.enqueue(chunk);
                    } else {
                        controller.close();
                    }
                },
            },
            { highWaterMark: 0 },
        );
        const original = new Response(source, {
            status: 202,
            statusText: 'Accepted',
            headers: { 'content-type': 'text/event-stream', 'x-synthetic': 'preserved' },
        });
        Object.defineProperty(original, 'url', {
            configurable: true,
            value: 'https://chatgpt.com/backend-api/f/conversation',
        });

        const monitored = createMonitoredFetchResponse(original, streamId, recorder, { framing: 'sse' });
        await Promise.resolve();

        expect(pullCount).toBe(0);
        expect(recorder.getStream(streamId)?.frames).toEqual([]);
        expect(monitored.status).toBe(202);
        expect(monitored.statusText).toBe('Accepted');
        expect(monitored.headers.get('content-type')).toBe('text/event-stream');
        expect(monitored.headers.get('x-synthetic')).toBe('preserved');
        expect(monitored.url).toBe(original.url);

        const reader = monitored.body!.getReader();
        const first = await reader.read();
        await Promise.resolve();
        expect(new TextDecoder().decode(first.value)).toBe('data: refusal\n\n');
        expect(pullCount).toBe(1);
        expect(recorder.getStream(streamId)?.frames.map((frame) => frame.kind)).toEqual(['refusal']);

        const second = await reader.read();
        await Promise.resolve();
        expect(new TextDecoder().decode(second.value)).toBe('data: [DONE]\n\n');
        expect(pullCount).toBe(2);
        expect(recorder.getStream(streamId)?.frames.map((frame) => frame.kind)).toEqual(['refusal', 'done']);

        expect((await reader.read()).done).toBeTrue();
        expect(pullCount).toBe(3);
        expect(recorder.getStream(streamId)?.status).toBe('closed');
    });

    it('should propagate page cancellation upstream without pulling another chunk', async () => {
        const recorder = createStreamDebugRecorder();
        const streamId = recorder.startStream({
            streamId: 'stream-page-cancel',
            platform: 'Qwen',
            endpoint: 'generation',
            method: 'POST',
            url: '/api/v2/chat/completions',
        });
        let pullCount = 0;
        let cancelReason: unknown;
        const original = new Response(
            new ReadableStream<Uint8Array>(
                {
                    pull() {
                        pullCount += 1;
                    },
                    cancel(reason) {
                        cancelReason = reason;
                    },
                },
                { highWaterMark: 0 },
            ),
        );
        const monitored = createMonitoredFetchResponse(original, streamId, recorder, { framing: 'sse' });

        await monitored.body!.cancel('page stopped reading');

        expect(pullCount).toBe(0);
        expect(cancelReason).toBe('page stopped reading');
        expect(recorder.getStream(streamId)?.status).toBe('aborted');
        expect(recorder.getStream(streamId)?.termination?.event).toBe('abort');
    });

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

        const monitored = createMonitoredFetchResponse(response, streamId, recorder, { framing: 'sse' });

        expect(await monitored.text()).toBe('data: refusal\n\ndata: replacement\n\ndata: erase\n\ndata: [DONE]\n\n');
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

        await createMonitoredFetchResponse(response, streamId, recorder, { framing: 'sse' }).arrayBuffer();

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

        await createMonitoredFetchResponse(response, streamId, recorder, { framing: 'line' }).arrayBuffer();

        const record = recorder.getStream(streamId);
        expect(record?.status).toBe('closed');
        expect(record?.totalRawBytes).toBe(200_000);
        expect(record?.totalByteLength).toBeLessThanOrEqual(16_384);
        expect(record?.frames.length).toBeGreaterThan(1);
        expect(record?.frames.every((frame) => frame.storedByteLength <= 4096)).toBeTrue();
        expect(record?.frames.every((frame) => frame.text.length <= 4096)).toBeTrue();
    });

    it('should pass every observed byte through to the page-owned response', async () => {
        const recorder = createStreamDebugRecorder();
        const streamId = recorder.startStream({
            streamId: 'stream-fetch-clone',
            platform: 'ChatGPT',
            endpoint: 'generation',
            method: 'POST',
            url: '/backend-api/f/conversation',
        });
        const response = responseFromChunks(['data: refusal\n\n', 'data: [DONE]\n\n']);

        const monitored = createMonitoredFetchResponse(response, streamId, recorder, { framing: 'sse' });

        expect(await monitored.text()).toBe('data: refusal\n\ndata: [DONE]\n\n');
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
        await createMonitoredFetchResponse(responseFromChunks(['line\n']), clean.streamId, clean.recorder, {
            framing: 'line',
        }).arrayBuffer();
        expect(clean.recorder.exportRecords()[0]?.status).toBe('closed');

        const abort = makeRecorder('stream-abort');
        const abortController = new AbortController();
        const abortResponse = responseFromChunks([], (controller) => {
            abortController.signal.addEventListener('abort', () => {
                controller.error(new DOMException('aborted', 'AbortError'));
            });
        });
        const abortReading = createMonitoredFetchResponse(abortResponse, abort.streamId, abort.recorder, {
            framing: 'raw',
            signal: abortController.signal,
        }).arrayBuffer();
        abortController.abort();
        await expect(abortReading).rejects.toBeInstanceOf(DOMException);
        expect(abort.recorder.exportRecords()[0]?.status).toBe('aborted');

        const error = makeRecorder('stream-error');
        const errorResponse = responseFromChunks([], (controller) => {
            controller.error(new Error('transport failed'));
        });
        await expect(
            createMonitoredFetchResponse(errorResponse, error.streamId, error.recorder, {
                framing: 'raw',
            }).arrayBuffer(),
        ).rejects.toThrow('transport failed');
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
        const reading = createMonitoredFetchResponse(response, streamId, recorder, {
            framing: 'raw',
            signal: abortController.signal,
        }).arrayBuffer();

        abortController.abort();
        await expect(
            Promise.race([
                reading,
                new Promise((_, reject) => setTimeout(() => reject(new Error('monitor did not settle')), 100)),
            ]),
        ).rejects.toBeInstanceOf(DOMException);
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

        createMonitoredFetchResponse(new Response(null, { status: 204 }), streamId, recorder, { framing: 'sse' });

        expect(recorder.getStream(streamId)?.status).toBe('closed');
        expect(recorder.getStream(streamId)?.termination?.event).toBe('close');
    });
});
