import { expect, it } from 'bun:test';
import { SUPPORTED_PLATFORM_URLS } from './constants';

it('should inject the extension on x.com Grok pages', () => {
    expect(SUPPORTED_PLATFORM_URLS).toContain('https://x.com/i/grok*');
});

it('should inject the extension on every cache-first conversation platform', () => {
    expect(SUPPORTED_PLATFORM_URLS).toEqual(
        expect.arrayContaining([
            'https://claude.ai/*',
            'https://chat.deepseek.com/*',
            'https://chat.qwen.ai/*',
            'https://chat.z.ai/*',
            'https://www.meta.ai/*',
            'https://meta.ai/*',
            'https://nova.amazon.com/*',
        ]),
    );
});
