import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
    modules: ['@wxt-dev/module-react'],
    manifest: {
        name: 'Blackiya',
        description: 'Capture and save conversation JSON from ChatGPT, Gemini, and other LLMs',
        permissions: ['storage', 'activeTab', 'downloads'],
        host_permissions: ['https://chatgpt.com/*', 'https://chat.openai.com/*', 'https://gemini.google.com/*'],
    },
});
