export function normalizeGrokStreamChunk(chunk: string): string {
    return chunk.replace(/\r\n/g, '\n');
}
