import { describe, expect, it } from 'bun:test';
import {
    CHATGPT_ENDPOINT_REGISTRY,
    isChatGptGeneratingFromDom,
    isLikelyChatGptApiPath,
    resolveChatGptButtonInjectionTarget,
} from '@/platforms/chatgpt/registry';

describe('chatgpt registry', () => {
    it('should expose endpoint patterns matching prompt and completion URLs', () => {
        expect(
            CHATGPT_ENDPOINT_REGISTRY.promptRequestPathPattern.test('/backend-api/f/conversation?model=gpt-4'),
        ).toBeTrue();
        expect(
            CHATGPT_ENDPOINT_REGISTRY.completionTriggerPattern.test(
                '/backend-api/conversation/696bc3d5-fa84-8328-b209-4d65cb229e59/stream_status',
            ),
        ).toBeTrue();
    });

    it('should resolve button injection target from selector matches', () => {
        const parent = { id: 'parent' } as unknown as HTMLElement;
        const doc = {
            querySelector: (selector: string) =>
                selector === '[data-testid="model-switcher-dropdown-button"]'
                    ? ({ parentElement: parent } as unknown as Element)
                    : null,
        };
        expect(resolveChatGptButtonInjectionTarget(doc)).toBe(parent);
    });

    it('should detect generation state from configured selectors', () => {
        const doc = {
            querySelector: (selector: string) =>
                selector === 'button[data-testid="stop-button"]' ? ({} as Element) : null,
        };
        expect(isChatGptGeneratingFromDom(doc)).toBeTrue();
    });

    it('should classify likely chatgpt api paths for endpoint-miss diagnostics', () => {
        expect(isLikelyChatGptApiPath('https://chatgpt.com/backend-api/textdocs/abc')).toBeTrue();
        expect(isLikelyChatGptApiPath('https://chatgpt.com/c/123')).toBeFalse();
    });
});
