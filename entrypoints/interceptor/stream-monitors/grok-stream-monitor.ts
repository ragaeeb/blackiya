export const normalizeGrokStreamChunk = (chunk: string): string => {
    return chunk.replace(/\r\n/g, '\n');
};
