export type JsonBridgeFormat = 'original' | 'common';

interface JsonBridgeRequestMessage {
    type: string;
    requestId: string;
    format: JsonBridgeFormat;
}

interface JsonBridgeResponseMessage {
    type: string;
    requestId: string;
    success: boolean;
    data?: unknown;
    error?: string;
}

export interface CreateWindowJsonRequesterOptions {
    requestType: string;
    responseType: string;
    timeoutMs?: number;
    makeRequestId?: () => string;
}

function defaultRequestId(): string {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
        return crypto.randomUUID();
    }
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function createWindowJsonRequester(
    targetWindow: Window,
    options: CreateWindowJsonRequesterOptions,
): (format: JsonBridgeFormat) => Promise<unknown> {
    const timeoutMs = options.timeoutMs ?? 5_000;
    const makeRequestId = options.makeRequestId ?? defaultRequestId;
    return (format: JsonBridgeFormat) =>
        new Promise((resolve, reject) => {
            const requestId = makeRequestId();
            let timeoutId: number | undefined;
            const isResponseMessage = (
                event: MessageEvent,
                id: string,
            ): event is MessageEvent<JsonBridgeResponseMessage> => {
                if (event.source !== targetWindow || event.origin !== targetWindow.location.origin) {
                    return false;
                }
                const message = event.data as JsonBridgeResponseMessage | null;
                return !!message && message.type === options.responseType && message.requestId === id;
            };

            const cleanup = () => {
                if (timeoutId !== undefined) {
                    clearTimeout(timeoutId);
                }
                targetWindow.removeEventListener('message', handler);
            };

            const handler = (event: MessageEvent) => {
                if (!isResponseMessage(event, requestId)) {
                    return;
                }
                const message = event.data;
                cleanup();
                if (message.success) {
                    resolve(message.data);
                    return;
                }
                reject(new Error(message.error || 'FAILED'));
            };

            targetWindow.addEventListener('message', handler);
            const request: JsonBridgeRequestMessage = {
                type: options.requestType,
                requestId,
                format,
            };
            targetWindow.postMessage(request, targetWindow.location.origin);
            timeoutId = targetWindow.setTimeout(() => {
                cleanup();
                reject(new Error('TIMEOUT'));
            }, timeoutMs);
        });
}
