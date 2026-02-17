import { describe, expect, it } from 'bun:test';
import { getPlatformAdapterByApiUrl, getPlatformAdapterByCompletionUrl } from '@/platforms/factory';

describe('platform factory URL matching', () => {
    it('should resolve Gemini adapter for relative StreamGenerate XHR URL', () => {
        const adapter = getPlatformAdapterByApiUrl(
            '/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?rt=c',
        );
        expect(adapter?.name).toBe('Gemini');
    });

    it('should resolve Gemini adapter for relative batchexecute XHR URL', () => {
        const adapter = getPlatformAdapterByApiUrl('/_/BardChatUi/data/batchexecute?rpcids=ESY5D&rt=c');
        expect(adapter?.name).toBe('Gemini');
    });

    it('should resolve Gemini completion adapter for relative StreamGenerate URL', () => {
        const adapter = getPlatformAdapterByCompletionUrl(
            '/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?rt=c',
        );
        expect(adapter?.name).toBe('Gemini');
    });
});
