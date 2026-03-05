export const GEMINI_BATCHEXECUTE_CONTEXT_REQUEST_MESSAGE = 'BLACKIYA_GEMINI_BATCHEXECUTE_CONTEXT_REQUEST';
export const GEMINI_BATCHEXECUTE_CONTEXT_RESPONSE_MESSAGE = 'BLACKIYA_GEMINI_BATCHEXECUTE_CONTEXT_RESPONSE';

export type GeminiBatchexecuteContext = {
    bl?: string;
    fSid?: string;
    hl?: string;
    rt?: string;
    reqid?: number;
    at?: string;
    updatedAt: number;
};

export type GeminiBatchexecuteContextRequestMessage = {
    type: typeof GEMINI_BATCHEXECUTE_CONTEXT_REQUEST_MESSAGE;
    requestId: string;
    __blackiyaToken?: string;
};

export type GeminiBatchexecuteContextResponseMessage = {
    type: typeof GEMINI_BATCHEXECUTE_CONTEXT_RESPONSE_MESSAGE;
    requestId: string;
    context?: GeminiBatchexecuteContext;
    __blackiyaToken?: string;
};

export const isGeminiBatchexecuteContextRequestMessage = (
    value: unknown,
): value is GeminiBatchexecuteContextRequestMessage => {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const typed = value as Partial<GeminiBatchexecuteContextRequestMessage>;
    return (
        typed.type === GEMINI_BATCHEXECUTE_CONTEXT_REQUEST_MESSAGE &&
        typeof typed.requestId === 'string' &&
        typed.requestId.length > 0
    );
};

export const isGeminiBatchexecuteContextResponseMessage = (
    value: unknown,
): value is GeminiBatchexecuteContextResponseMessage => {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const typed = value as Partial<GeminiBatchexecuteContextResponseMessage>;
    return (
        typed.type === GEMINI_BATCHEXECUTE_CONTEXT_RESPONSE_MESSAGE &&
        typeof typed.requestId === 'string' &&
        typed.requestId.length > 0
    );
};
