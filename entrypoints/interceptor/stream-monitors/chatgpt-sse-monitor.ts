export type ChatgptSseChunkHandler = (chunk: string) => void;

export function monitorChatgptSseChunk(chunk: string, onChunk: ChatgptSseChunkHandler): void {
    if (!chunk) {
        return;
    }
    onChunk(chunk);
}
