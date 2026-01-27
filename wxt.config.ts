import { defineConfig } from 'wxt';
import { SUPPORTED_PLATFORM_URLS } from './platforms/constants';

// See https://wxt.dev/api/config.html
export default defineConfig({
    modules: [],
    vite: () => ({
        resolve: {
            alias: {
                react: 'preact/compat',
                'react-dom': 'preact/compat',
                'react-dom/test-utils': 'preact/test-utils',
            },
        },
    }),
    manifest: {
        name: 'Blackiya',
        description: 'Capture and save conversation JSON from ChatGPT, Gemini, and other LLMs',
        permissions: ['storage', 'activeTab', 'downloads'],
        externally_connectable: {
            ids: ['pngbgngdjojmnajfgfecpgbhpehmcjfj'],
        },
        host_permissions: [...SUPPORTED_PLATFORM_URLS],
        action: {
            default_icon: 'icon.png',
        },
        icons: {
            '16': 'icon/16.png',
            '32': 'icon/32.png',
            '48': 'icon/48.png',
            '128': 'icon/128.png',
        },
    },
});
