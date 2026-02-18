export type ChatgptSseChunkHandler = (chunk: string) => void;

export function monitorChatgptSseChunk(chunk: string, onChunk: ChatgptSseChunkHandler): void {
    if (!chunk || chunk.trim().length === 0) {
        return;
    }
    onChunk(chunk);
}
