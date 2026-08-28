import { isDeclaredBodyOversized } from './conversation-response-capture';

const cancelReader = (reader: ReadableStreamDefaultReader<Uint8Array>): void => {
    try {
        void reader.cancel().catch(() => undefined);
    } catch {}
};

export const readBoundedRequestBodyWithDeadline = async (
    request: Pick<Request, 'body' | 'headers'>,
    maxBytes: number,
    deadlineMs: number,
): Promise<string | null> => {
    if (!request.body || isDeclaredBodyOversized(request, maxBytes)) {
        return null;
    }
    const reader = request.body.getReader();
    const decoder = new TextDecoder();
    let observedBytes = 0;
    let text = '';
    let deadlineHandle: ReturnType<typeof setTimeout> | undefined;
    const read = async (): Promise<string | null> => {
        try {
            while (true) {
                const chunk = await reader.read();
                if (chunk.done) {
                    text += decoder.decode();
                    return text;
                }
                observedBytes += chunk.value.byteLength;
                if (observedBytes > maxBytes) {
                    cancelReader(reader);
                    return null;
                }
                text += decoder.decode(chunk.value, { stream: true });
            }
        } catch {
            return null;
        }
    };
    const deadline = new Promise<null>((resolve) => {
        deadlineHandle = setTimeout(
            () => {
                cancelReader(reader);
                resolve(null);
            },
            Math.max(1, deadlineMs),
        );
    });
    try {
        return await Promise.race([read(), deadline]);
    } finally {
        clearTimeout(deadlineHandle);
    }
};
