import { runPlatform } from '@/utils/platform-runner';

/**
 * Unified Content Script for all LLM Platforms
 *
 * This script runs on all supported LLM domains and uses the
 * adapter pattern to determine specific behavior.
 */
export default defineContentScript({
    // Add all supported LLM domains here
    matches: ['https://chatgpt.com/*', 'https://chat.openai.com/*', 'https://gemini.google.com/*'],
    runAt: 'document_idle',
    main() {
        runPlatform();
    },
});
