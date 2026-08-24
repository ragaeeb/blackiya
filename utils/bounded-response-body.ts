export const MAX_EXPLICIT_EXPORT_RESPONSE_BYTES = 16 * 1024 * 1024;

export type BoundedResponseBodyResult =
    | { kind: 'success'; text: string }
    | { kind: 'too_large' };

type ReadBoundedResponseBodyOptions = {
    maxBytes: number;
    signal?: AbortSignal;
};

const getDeclaredBodyBytes = (response: Pick<Response, 'headers'>): number | null => {
    const value = response.headers?.get('content-length');
    if (!value || !/^\d+$/.test(value)) {
        return null;
    }
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
};

const cancelBody = async (body: ReadableStream<Uint8Array> | null): Promise<void> => {
    try {
        await body?.cancel();
    } catch {
        // Cleanup failure must not hide the typed size failure.
    }
};

const abortError = (signal: AbortSignal): Error => {
    if (signal.reason instanceof Error) {
        return signal.reason;
    }
    return new DOMException('The operation was aborted.', 'AbortError');
};

const awaitWithAbort = async <T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> => {
    if (!signal) {
        return promise;
    }
    if (signal.aborted) {
        throw abortError(signal);
    }
    return new Promise<T>((resolve, reject) => {
        const onAbort = () => {
            cleanup();
            reject(abortError(signal));
        };
        const cleanup = () => signal.removeEventListener('abort', onAbort);
        signal.addEventListener('abort', onAbort, { once: true });
        promise.then(
            (value) => {
                cleanup();
                resolve(value);
            },
            (error: unknown) => {
                cleanup();
                reject(error);
            },
        );
    });
};

export const readBoundedResponseBodyText = async (
    response: Response,
    options: ReadBoundedResponseBodyOptions,
): Promise<BoundedResponseBodyResult> => {
    const { maxBytes, signal } = options;
    const declaredBytes = getDeclaredBodyBytes(response);
    if (declaredBytes !== null && declaredBytes > maxBytes) {
        await cancelBody(response.body);
        return { kind: 'too_large' };
    }
    if (signal?.aborted) {
        await cancelBody(response.body);
        throw abortError(signal);
    }

    if (!response.body) {
        const text = await awaitWithAbort(response.text(), signal);
        return new TextEncoder().encode(text).byteLength > maxBytes ? { kind: 'too_large' } : { kind: 'success', text };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let observedBytes = 0;
    let text = '';
    const onAbort = () => {
        void reader.cancel().catch(() => undefined);
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
        while (true) {
            const chunk = await reader.read();
            if (signal?.aborted) {
                throw abortError(signal);
            }
            if (chunk.done) {
                text += decoder.decode();
                return { kind: 'success', text };
            }
            observedBytes += chunk.value.byteLength;
            if (observedBytes > maxBytes) {
                await reader.cancel().catch(() => undefined);
                return { kind: 'too_large' };
            }
            text += decoder.decode(chunk.value, { stream: true });
        }
    } finally {
        signal?.removeEventListener('abort', onAbort);
        reader.releaseLock();
    }
};
