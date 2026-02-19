export type ChatgptSseChunkHandler = (chunk: string) => void;

export const monitorChatgptSseChunk = (chunk: string, onChunk: ChatgptSseChunkHandler) => {
    if (!chunk || chunk.trim().length === 0) {
        return;
    }
    onChunk(chunk);
};
