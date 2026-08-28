import { describe, expect, it } from 'bun:test';
import { createStreamDebugRecorder } from '@/features/stream-debug/recorder';
import { createXhrStreamCapture } from '@/features/stream-debug/xhr-monitor';

describe('stream-debug XHR monitor', () => {
    it('should capture only incremental responseText in order, including final events', () => {
        let responseText = 'data: refusal\n\ndata: repl';
        const recorder = createStreamDebugRecorder();
        const streamId = recorder.startStream({
            streamId: 'stream-xhr-1',
            platform: 'Gemini',
            endpoint: 'generation',
            method: 'POST',
            url: '/stream',
        });
        const capture = createXhrStreamCapture({
            streamId,
            recorder,
            framing: 'sse',
            readResponseText: () => responseText,
        });

        capture.progress();
        responseText += 'acement\n\ndata: erase\n\ndata: [DONE]\n\n';
        capture.progress();
        capture.load();
        capture.loadEnd();

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

    it('should retain late refusal, replacement, erase, and done frames through recorder bounds', () => {
        const responseText =
            'data: ordinary-1\n\ndata: ordinary-2\n\ndata: ordinary-3\n\ndata: ordinary-4\n\n' +
            'data: refusal\n\ndata: replacement\n\ndata: erase\n\ndata: [DONE]\n\n';
        const recorder = createStreamDebugRecorder({
            maxFramesPerStream: 4,
            maxStreamBytes: 80,
            maxFrameBytes: 80,
        });
        const streamId = recorder.startStream({
            streamId: 'stream-xhr-late-signals',
            platform: 'Gemini',
            endpoint: 'generation',
            method: 'POST',
            url: '/stream',
        });
        const capture = createXhrStreamCapture({
            streamId,
            recorder,
            framing: 'sse',
            readResponseText: () => responseText,
        });

        capture.progress();
        capture.loadEnd();

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

    it('should bound an unterminated XHR body without retaining the full response text', () => {
        const responseText = 'x'.repeat(200_000);
        const recorder = createStreamDebugRecorder({
            maxFrameBytes: 4096,
            maxStreamBytes: 16_384,
        });
        const streamId = recorder.startStream({
            streamId: 'stream-xhr-long-body',
            platform: 'Gemini',
            endpoint: 'generation',
            method: 'POST',
            url: '/stream',
        });
        const capture = createXhrStreamCapture({
            streamId,
            recorder,
            framing: 'line',
            readResponseText: () => responseText,
        });

        capture.progress();
        capture.loadEnd();

        const record = recorder.getStream(streamId);
        expect(record?.totalRawBytes).toBe(200_000);
        expect(record?.totalByteLength).toBeLessThanOrEqual(16_384);
        expect(record?.frames.every((frame) => frame.storedByteLength <= 4096)).toBeTrue();
    });

    it('should retain XHR abort and error termination without consuming page state', () => {
        for (const event of ['abort', 'error'] as const) {
            const recorder = createStreamDebugRecorder();
            const streamId = recorder.startStream({
                streamId: `stream-xhr-${event}`,
                platform: 'Grok',
                endpoint: 'generation',
                method: 'POST',
                url: '/stream',
            });
            let responseText = 'first';
            const capture = createXhrStreamCapture({
                streamId,
                recorder,
                framing: 'raw',
                readResponseText: () => responseText,
            });

            capture.progress();
            responseText = 'replacement';
            capture.progress();
            capture[event]();
            capture.loadEnd();

            expect(recorder.exportRecords()[0]?.frames.map((frame: any) => frame.text)).toEqual([
                'first',
                'replacement',
                '',
            ]);
            expect(recorder.exportRecords()[0]?.status).toBe(event === 'abort' ? 'aborted' : event);
            expect(recorder.exportRecords()[0]?.termination?.event).toBe(event);
        }
    });
});
