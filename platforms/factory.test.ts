import { describe, expect, it } from 'bun:test';
import { getPlatformAdapter } from './factory';

const UUID = '67f0a0b3-1234-4abc-8def-1234567890ab';

describe('platform adapter factory', () => {
    const cases = [
        ['ChatGPT', `https://chatgpt.com/c/${UUID}`],
        ['Gemini', 'https://gemini.google.com/app/20de061ec5dae81c'],
        ['Grok', 'https://grok.com/c/01cb0729-6455-471d-b33a-124b3de76a29'],
        ['Grok', 'https://x.com/i/grok?conversation=2091428436845772921'],
        ['Claude', `https://claude.ai/chat/${UUID}`],
        ['DeepSeek', `https://chat.deepseek.com/a/chat/s/${UUID}`],
        ['Qwen', `https://chat.qwen.ai/c/${UUID}`],
        ['Z.ai', `https://chat.z.ai/c/${UUID}`],
        ['Meta Muse', `https://www.meta.ai/prompt/${UUID}`],
        ['Amazon Nova', `https://nova.amazon.com/conversation/${UUID}`],
    ] as const;

    for (const [name, url] of cases) {
        it(`should resolve ${name}`, () => {
            expect(getPlatformAdapter(url)?.name).toBe(name);
        });
    }

    it('should not treat an unrelated x.com page as a Grok conversation', () => {
        expect(getPlatformAdapter('https://x.com/home')).toBeNull();
    });

    it('should select by exact provider origin instead of provider text in the query', () => {
        expect(getPlatformAdapter(`https://claude.ai/chat/${UUID}?source=chatgpt.com`)?.name).toBe('Claude');
        expect(getPlatformAdapter(`https://claude.ai/chat/${UUID}?source=gemini.google.com`)?.name).toBe('Claude');
        expect(getPlatformAdapter('https://example.invalid/?source=chatgpt.com&next=gemini.google.com')).toBeNull();
    });
});
