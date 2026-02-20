export type GeminiStreamMonitorContext = {
    attemptId: string;
    conversationId?: string;
};

export const shouldProcessGeminiChunk = (chunk: string): boolean => {
    return chunk.trim().length > 0;
};
