import { SUPPORTED_PLATFORM_URLS } from '@/platforms/constants';
import { runPlatform } from '@/utils/runner/runtime/platform-runtime';
import { loadExtensionEnabledSetting } from '@/utils/settings';

/**
 * Unified Content Script for all LLM Platforms
 *
 * This script runs on all supported LLM domains and uses the
 * adapter pattern to determine specific behavior.
 */
export default defineContentScript({
    matches: [...SUPPORTED_PLATFORM_URLS],
    runAt: 'document_idle',
    async main() {
        if (!(await loadExtensionEnabledSetting())) {
            return;
        }
        runPlatform();
    },
});
