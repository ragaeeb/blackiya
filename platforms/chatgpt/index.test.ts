import { beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('@/utils/logger', () => ({
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, setLevel: () => {} },
}));

describe('ChatGPT adapter smoke contract', () => {
    let adapter: any;

    beforeAll(async () => {
        const module = await import('@/platforms/chatgpt');
        adapter = module.createChatGPTAdapter();
    });

    it('should expose adapter identity and callable core methods', () => {
        expect(adapter.name).toBe('ChatGPT');
        expect(typeof adapter.isPlatformUrl).toBe('function');
        expect(typeof adapter.extractConversationId).toBe('function');
        expect(typeof adapter.extractConversationIdFromUrl).toBe('function');
        expect(typeof adapter.buildApiUrl).toBe('function');
        expect(typeof adapter.buildApiUrls).toBe('function');
        expect(typeof adapter.parseInterceptedData).toBe('function');
        expect(typeof adapter.evaluateReadiness).toBe('function');
        expect(typeof adapter.formatFilename).toBe('function');
        expect(typeof adapter.getButtonInjectionTarget).toBe('function');
    });
});
