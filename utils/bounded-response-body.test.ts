import { describe, expect, it } from 'bun:test';
import { readBoundedResponseBodyText } from './bounded-response-body';

describe('readBoundedResponseBodyText', () => {
    it('should reject a declared oversized response and cancel its body without reading', async () => {
        let pulls = 0;
        let cancelled = false;
        const body = new ReadableStream<Uint8Array>({
            pull() {
                pulls += 1;
            },
            cancel() {
                cancelled = true;
            },
        });
        const response = new Response(body, {
            headers: { 'content-length': '9' },
        });

        const result = await readBoundedResponseBodyText(response, { maxBytes: 8 });

        expect(result).toEqual({ kind: 'too_large' });
        expect(pulls).toBe(0);
        expect(cancelled).toBeTrue();
    });

    it('should reject streamed overflow and cancel the active reader', async () => {
        let cancelled = false;
        const response = new Response(
            new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode('12345678'));
                    controller.enqueue(new TextEncoder().encode('9'));
                },
                cancel() {
                    cancelled = true;
                },
            }),
        );

        const result = await readBoundedResponseBodyText(response, { maxBytes: 8 });

        expect(result).toEqual({ kind: 'too_large' });
        expect(cancelled).toBeTrue();
    });

    it('should decode multibyte text across chunk boundaries within the byte cap', async () => {
        const bytes = new TextEncoder().encode('🌍');
        const response = new Response(
            new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(bytes.slice(0, 2));
                    controller.enqueue(bytes.slice(2));
                    controller.close();
                },
            }),
        );

        const result = await readBoundedResponseBodyText(response, { maxBytes: bytes.byteLength });

        expect(result).toEqual({ kind: 'success', text: '🌍' });
    });
});
