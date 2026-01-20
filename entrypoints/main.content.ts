import { SUPPORTED_PLATFORM_URLS } from '@/platforms/constants';
import { runPlatform } from '@/utils/platform-runner';

/**
 * Unified Content Script for all LLM Platforms
 *
 * This script runs on all supported LLM domains and uses the
 * adapter pattern to determine specific behavior.
 */
export default defineContentScript({
    matches: [...SUPPORTED_PLATFORM_URLS],
    runAt: 'document_idle',
    main() {
        runPlatform();
    },
});
