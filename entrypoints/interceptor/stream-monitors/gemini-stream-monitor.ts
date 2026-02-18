export type GeminiStreamMonitorContext = {
    attemptId: string;
    conversationId?: string;
};

export function shouldProcessGeminiChunk(chunk: string): boolean {
    return chunk.trim().length > 0;
}
