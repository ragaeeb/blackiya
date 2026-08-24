import { describe, expect, it } from 'bun:test';
import { createStreamDebugRecorder } from './recorder';

describe('features/stream-debug/recorder comprehensive tests', () => {
    it('should exclude headers, cookies, auth values, request bodies, and query strings', () => {
        const recorder = createStreamDebugRecorder({ createStreamId: () => 'stream-private-1' });
        const streamId = recorder.startStream({
            platform: 'ChatGPT',
            endpoint: 'chatgpt-generation',
            method: 'POST',
            url: 'https://chatgpt.com/backend-api/conversation?access_token=secret_token&user=123',
            headers: { authorization: 'Bearer secret', cookie: 'session=123' },
            body: 'sensitive prompt text',
        } as any);

        recorder.appendFrame(streamId, 'data: {"message":{"content":{"parts":["hello"]}}}\n\n');

        const record = recorder.getStream(streamId);
        expect(record).toBeDefined();
        expect(record?.path).toBe('/backend-api/conversation');
        expect((record as any)?.url).toBeUndefined();
        expect((record as any).headers).toBeUndefined();
        expect((record as any).cookies).toBeUndefined();
        expect((record as any).body).toBeUndefined();

        const serialized = JSON.stringify(record);
        expect(serialized.includes('secret_token')).toBeFalse();
        expect(serialized.includes('authorization')).toBeFalse();
        expect(serialized.includes('cookie')).toBeFalse();
        expect(serialized.includes('sensitive prompt')).toBeFalse();
    });

    it('should preserve ordered frames across split fetch chunks', () => {
        const recorder = createStreamDebugRecorder({ createStreamId: () => 'stream-fetch-order' });
        const streamId = recorder.startStream({
            platform: 'ChatGPT',
            endpoint: 'chatgpt-generation',
            method: 'POST',
            url: 'https://chatgpt.com/backend-api/conversation',
        });

        // Split chunk 1: partial SSE
        recorder.appendFrame(streamId, 'data: {"message":');
        // Split chunk 2: remainder of SSE
        recorder.appendFrame(streamId, '{"content":"Hello world"}}\n\n');
        // Split chunk 3: [DONE]
        recorder.appendFrame(streamId, 'data: [DONE]\n\n');

        const record = recorder.getStream(streamId);
        expect(record?.frames).toHaveLength(3);
        expect(record?.frames?.[0]?.sequence).toBe(0);
        expect(record?.frames?.[0]?.text).toBe('data: {"message":');
        expect(record?.frames?.[1]?.sequence).toBe(1);
        expect(record?.frames?.[1]?.text).toBe('{"content":"Hello world"}}\n\n');
        expect(record?.frames?.[2]?.sequence).toBe(2);
        expect(record?.frames?.[2]?.event).toBe('done');
        expect(record?.frames?.[2]?.text).toBe('data: [DONE]\n\n');
    });

    it('should support incremental XHR capture', () => {
        const recorder = createStreamDebugRecorder({ createStreamId: () => 'stream-xhr-order' });
        const streamId = recorder.startStream({
            platform: 'Gemini',
            endpoint: 'gemini-generation',
            method: 'POST',
            url: 'https://gemini.google.com/StreamGenerate',
        });

        const delta1 = '[[["wrb.fr",null,null,null,null,1]]';
        const delta2 = ',[["wrb.fr",null,null,null,null,2]]]';

        recorder.appendFrame(streamId, delta1);
        recorder.appendFrame(streamId, delta2);

        const record = recorder.getStream(streamId);
        expect(record?.frames).toHaveLength(2);
        expect(record?.frames?.[0]?.text).toBe(delta1);
        expect(record?.frames?.[1]?.text).toBe(delta2);
        expect(`${record?.frames?.[0]?.text}${record?.frames?.[1]?.text}`).toBe(delta1 + delta2);
    });

    it('should retain final refusal, replacement, and erase events in exact order', () => {
        const recorder = createStreamDebugRecorder({ createStreamId: () => 'stream-grok-events' });
        const streamId = recorder.startStream({
            platform: 'Grok',
            endpoint: 'grok-generation',
            method: 'POST',
            url: 'https://grok.com/2/grok/add_response.json',
        });

        recorder.appendFrame(streamId, '{"result":{"response":{"token":"Here is the recipe"}}}');
        recorder.appendFrame(streamId, '{"result":{"response":{"action":"erase_previous_tokens"}}}', {
            event: 'erase',
        });
        recorder.appendFrame(streamId, '{"result":{"response":{"action":"replace","text":"I cannot provide this"}}}', {
            event: 'replacement',
        });
        recorder.appendFrame(streamId, '{"result":{"response":{"is_refusal":true,"refusal_reason":"policy"}}}', {
            event: 'refusal',
        });

        const record = recorder.getStream(streamId);
        expect(record?.frames).toHaveLength(4);
        expect(record?.frames?.[1]?.event).toBe('erase');
        expect(record?.frames?.[2]?.event).toBe('replacement');
        expect(record?.frames?.[3]?.event).toBe('refusal');
    });

    it('should handle clean close, abort, and error statuses', () => {
        const recorder = createStreamDebugRecorder();

        const stream1 = recorder.startStream({
            platform: 'ChatGPT',
            endpoint: 'chatgpt-generation',
            method: 'POST',
            url: '/stream1',
        });
        recorder.terminateStream(stream1, 'close');
        expect(recorder.getStream(stream1)?.termination?.event).toBe('close');

        const stream2 = recorder.startStream({
            platform: 'ChatGPT',
            endpoint: 'chatgpt-generation',
            method: 'POST',
            url: '/stream2',
        });
        recorder.terminateStream(stream2, 'abort');
        expect(recorder.getStream(stream2)?.termination?.event).toBe('abort');

        const stream3 = recorder.startStream({
            platform: 'Gemini',
            endpoint: 'gemini-generation',
            method: 'POST',
            url: '/stream3',
        });
        recorder.terminateStream(stream3, 'error');
        expect(recorder.getStream(stream3)?.termination?.event).toBe('error');
    });

    it('should ensure recorder failure cannot affect the page or throw', () => {
        const recorder = createStreamDebugRecorder();
        const streamId = recorder.startStream({
            platform: 'ChatGPT',
            endpoint: 'chatgpt-generation',
            method: 'POST',
            url: '/backend-api/conversation',
        });

        expect(() => {
            recorder.appendFrame(streamId, null as any);
        }).not.toThrow();

        expect(() => {
            recorder.terminateStream(streamId, null as any);
        }).not.toThrow();

        expect(() => {
            recorder.startStream(null as any);
        }).not.toThrow();
    });

    it('should enforce stream-count and TTL eviction', () => {
        let currentTime = 10_000;
        const recorder = createStreamDebugRecorder({
            now: () => currentTime,
            maxStreams: 2,
            ttlMs: 5000,
        });

        const s1 = recorder.startStream({ platform: 'ChatGPT', endpoint: 'chatgpt-gen', method: 'POST', url: '/s1' });
        recorder.terminateStream(s1, 'close');

        currentTime = 12_000;
        recorder.startStream({ platform: 'ChatGPT', endpoint: 'chatgpt-gen', method: 'POST', url: '/s2' });

        currentTime = 16_000; // s1 is 6000ms old (> 5000ms TTL)
        expect(recorder.exportRecords(currentTime).map((r) => r.path)).toEqual(['/s2']);

        currentTime = 16_500;
        recorder.startStream({ platform: 'ChatGPT', endpoint: 'chatgpt-gen', method: 'POST', url: '/s3' });
        recorder.startStream({ platform: 'ChatGPT', endpoint: 'chatgpt-gen', method: 'POST', url: '/s4' });

        // maxStreams is 2 -> s2 evicted when s4 added
        const remaining = recorder.exportRecords(currentTime).map((r) => r.path);
        expect(remaining).toHaveLength(2);
        expect(remaining).toEqual(['/s3', '/s4']);
    });

    it('should automatically evict an abandoned active stream after its inactivity TTL', () => {
        let currentTime = 10_000;
        let scheduled: (() => void) | undefined;
        const recorder = createStreamDebugRecorder({
            now: () => currentTime,
            ttlMs: 1_000,
            createStreamId: () => 'stream-late-terminal',
            schedulePrune: (callback) => {
                scheduled = callback;
                return callback;
            },
            cancelPrune: () => undefined,
        });
        const streamId = recorder.startStream({
            platform: 'ChatGPT',
            endpoint: 'chatgpt-generation',
            method: 'POST',
            url: '/stream',
        });

        currentTime = 12_000;
        scheduled?.();
        expect(recorder.getStream(streamId)).toBeUndefined();
    });

    it('should retain a termination frame when close arrives after the nominal TTL', () => {
        let currentTime = 10_000;
        const recorder = createStreamDebugRecorder({
            now: () => currentTime,
            ttlMs: 1_000,
            createStreamId: () => 'stream-late-close',
            schedulePrune: () => 1,
            cancelPrune: () => undefined,
        });
        const streamId = recorder.startStream({
            platform: 'ChatGPT',
            endpoint: 'chatgpt-generation',
            method: 'POST',
            url: '/stream',
        });

        currentTime = 12_000;
        expect(recorder.terminateStream(streamId, 'close')).toBeTrue();
        const record = recorder.getStream(streamId);
        expect(record?.termination?.event).toBe('close');
        expect(record?.frames.at(-1)?.event).toBe('close');
    });

    it('should not promote control words embedded in ordinary content', () => {
        const recorder = createStreamDebugRecorder({ createStreamId: () => 'stream-control-prose' });
        const streamId = recorder.startStream({
            platform: 'ChatGPT',
            endpoint: 'chatgpt-generation',
            method: 'POST',
            url: '/stream',
        });

        recorder.appendFrame(streamId, '{"message":{"content":"replace the deleted paragraph [DONE]"}}');
        recorder.appendFrame(streamId, 'The refusal policy is documented here.');

        expect(recorder.getStream(streamId)?.frames.map((frame) => frame.kind)).toEqual(['data', 'data']);
    });

    it('should classify structured control fields without caller-provided events', () => {
        const recorder = createStreamDebugRecorder({ createStreamId: () => 'stream-structured-signals' });
        const streamId = recorder.startStream({
            platform: 'Grok',
            endpoint: 'grok-generation',
            method: 'POST',
            url: '/stream',
        });

        recorder.appendFrame(streamId, '{"response":{"action":"erase_previous_tokens"}}');
        recorder.appendFrame(streamId, '{"response":{"action":"replace","text":"I cannot help"}}');
        recorder.appendFrame(streamId, '{"response":{"is_refusal":true,"refusal_reason":"policy"}}');

        expect(recorder.getStream(streamId)?.frames.map((frame) => ({ kind: frame.kind, event: frame.event }))).toEqual(
            [
                { kind: 'erase', event: 'erase' },
                { kind: 'replacement', event: 'replacement' },
                { kind: 'refusal', event: 'refusal' },
            ],
        );
    });

    it('should not classify false, null, or empty refusal fields as refusal signals', () => {
        const recorder = createStreamDebugRecorder({ createStreamId: () => 'stream-non-refusal-fields' });
        const streamId = recorder.startStream({
            platform: 'ChatGPT',
            endpoint: 'generation',
            method: 'POST',
            url: '/stream',
        });

        recorder.appendFrame(streamId, '{"response":{"refusal":false,"refusal_reason":null}}');
        recorder.appendFrame(streamId, '{"response":{"refusal":""}}');

        expect(recorder.getStream(streamId)?.frames.map((frame) => frame.kind)).toEqual(['data', 'data']);
    });

    it('should enforce per-frame and stream size limits with truncation metadata', () => {
        const recorder = createStreamDebugRecorder({
            maxFrameBytes: 10,
            maxStreamBytes: 25,
            createStreamId: () => 'stream-limited',
        });

        const streamId = recorder.startStream({
            platform: 'ChatGPT',
            endpoint: 'chatgpt-generation',
            method: 'POST',
            url: '/stream',
        });

        // Frame 1: 15 bytes -> truncated to maxFrameBytes = 10
        recorder.appendFrame(streamId, '123456789012345');
        let record = recorder.getStream(streamId);
        expect(record?.frames?.[0]?.truncated).toBeTrue();
        expect(record?.frames?.[0]?.storedByteLength).toBe(10);
        expect(record?.frames?.[0]?.originalByteLength).toBe(15);
        expect(record?.truncated).toBeTrue();

        // Frame 2: 10 bytes -> fits in remaining 15 stream bytes (10 + 10 = 20 <= 25)
        recorder.appendFrame(streamId, 'abcdefghij');
        record = recorder.getStream(streamId);
        expect(record?.frames?.[1]?.truncated).toBeFalse();
        expect(record?.frames?.[1]?.storedByteLength).toBe(10);

        // Frame 3: 10 bytes -> only 5 bytes available (25 - 20 = 5)
        recorder.appendFrame(streamId, 'klmnopqrst');
        record = recorder.getStream(streamId);
        expect(record?.frames?.[2]?.truncated).toBeTrue();
        expect(record?.frames?.[2]?.storedByteLength).toBe(5);
        expect(record?.droppedByteLength).toBe(10); // 5 from frame 1 + 5 from frame 3
    });

    it('should preserve late refusal and erase events when the stream byte budget is full', () => {
        const recorder = createStreamDebugRecorder({
            maxFrameBytes: 8,
            maxStreamBytes: 12,
            maxFramesPerStream: 4,
            createStreamId: () => 'stream-late-events',
        });
        const streamId = recorder.startStream({
            platform: 'Grok',
            endpoint: 'grok-generation',
            method: 'POST',
            url: '/2/grok/add_response.json',
        });

        recorder.appendFrame(streamId, 'normal-1');
        recorder.appendFrame(streamId, 'normal-2');
        recorder.appendFrame(streamId, 'erase!', { event: 'erase' });
        recorder.appendFrame(streamId, 'refuse', { event: 'refusal' });

        const record = recorder.getStream(streamId);
        expect(record?.frames.map((frame) => frame.event ?? frame.text)).toEqual(['erase', 'refusal']);
        expect(record?.frames.every((frame) => frame.storedByteLength > 0)).toBeTrue();
        expect(record?.frames.find((frame) => frame.event === 'erase')?.text).toBe('erase!');
        expect(record?.frames.find((frame) => frame.event === 'refusal')?.text).toBe('refuse');
        expect(record?.totalByteLength).toBe(
            record?.frames.reduce((total, frame) => total + frame.storedByteLength, 0),
        );
        expect(record?.totalByteLength).toBeLessThanOrEqual(12);
    });

    it('should keep byte counters correct after evicting ordinary frames', () => {
        const recorder = createStreamDebugRecorder({
            maxFramesPerStream: 2,
            maxStreamBytes: 100,
            createStreamId: () => 'stream-eviction-accounting',
        });
        const streamId = recorder.startStream({
            platform: 'ChatGPT',
            endpoint: 'chatgpt-generation',
            method: 'POST',
            url: '/backend-api/f/conversation',
        });

        recorder.appendFrame(streamId, '12345');
        recorder.appendFrame(streamId, '1234567');
        recorder.appendFrame(streamId, '123');

        const record = recorder.getStream(streamId);
        expect(record?.frames.map((frame) => frame.text)).toEqual(['1234567', '123']);
        expect(record?.totalRawBytes).toBe(15);
        expect(record?.totalRawFrames).toBe(3);
        expect(record?.totalByteLength).toBe(10);
        expect(record?.droppedByteLength).toBe(5);
        expect(record?.truncatedBytes).toBe(5);
        expect(record?.droppedFrameCount).toBe(1);
        expect(record?.truncatedFrames).toBe(1);
        expect(record?.truncated).toBeTrue();
    });

    it('should report partial frame truncation with consistent byte metadata', () => {
        const recorder = createStreamDebugRecorder({
            maxFrameBytes: 4,
            maxStreamBytes: 6,
            createStreamId: () => 'stream-truncation-metadata',
        });
        const streamId = recorder.startStream({
            platform: 'Gemini',
            endpoint: 'gemini-generation',
            method: 'POST',
            url: '/streamgenerate',
        });

        recorder.appendFrame(streamId, '123456');
        recorder.appendFrame(streamId, 'abcdef');

        const record = recorder.getStream(streamId);
        expect(record?.frames.map((frame) => frame.storedByteLength)).toEqual([4, 2]);
        expect(record?.frames.every((frame) => frame.truncated)).toBeTrue();
        expect(record?.frames.map((frame) => frame.originalByteLength)).toEqual([6, 6]);
        expect(record?.totalByteLength).toBe(6);
        expect(record?.droppedByteLength).toBe(6);
        expect(record?.truncatedBytes).toBe(6);
        expect(record?.truncatedFrames).toBe(2);
    });
});
