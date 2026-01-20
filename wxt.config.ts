import { defineConfig } from 'wxt';
import { SUPPORTED_PLATFORM_URLS } from './platforms/constants';

// See https://wxt.dev/api/config.html
export default defineConfig({
    modules: ['@wxt-dev/module-react'],
    manifest: {
        name: 'Blackiya',
        description: 'Capture and save conversation JSON from ChatGPT, Gemini, and other LLMs',
        permissions: ['storage', 'activeTab', 'downloads'],
        host_permissions: [...SUPPORTED_PLATFORM_URLS],
        action: {
            default_icon: 'icon.svg',
        },
        icons: {
            '16': 'icon.svg',
            '32': 'icon.svg',
            '48': 'icon.svg',
            '128': 'icon.svg',
        },
    },
});
