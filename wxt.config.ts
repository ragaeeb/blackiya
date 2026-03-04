import { execSync } from 'node:child_process';
import { defineConfig } from 'wxt';
import { SUPPORTED_PLATFORM_URLS } from './platforms/constants';

const ALLITERATION_CODENAMES = [
    'Agile Aardvark',
    'Brisk Badger',
    'Calm Cheetah',
    'Daring Dolphin',
    'Eager Eagle',
    'Fuzzy Falcon',
    'Gentle Giraffe',
    'Humble Hedgehog',
    'Icy Ibex',
    'Jolly Jaguar',
    'Kind Koala',
    'Lively Lynx',
    'Mellow Marmot',
    'Nimble Newt',
    'Odd Otter',
    'Plucky Penguin',
    'Quick Quokka',
    'Rapid Raccoon',
    'Steady Sparrow',
    'Tidy Tiger',
    'Urban Urchin',
    'Vivid Vulture',
    'Witty Walrus',
    'Xtra Xenops',
    'Young Yak',
    'Zesty Zebra',
] as const;

const BUILD_CREATED_AT = new Date().toISOString();
const resolveCommitShortSha = () => {
    try {
        return execSync('git rev-parse --short HEAD', {
            stdio: ['ignore', 'pipe', 'ignore'],
        })
            .toString()
            .trim();
    } catch {
        return 'nogit';
    }
};

const BUILD_COMMIT_SHA = resolveCommitShortSha();
const BUILD_ID = `${BUILD_COMMIT_SHA}-${Date.now().toString(36)}`;
const codenameIndex =
    BUILD_ID.split('').reduce((sum, char) => sum + char.charCodeAt(0), 0) % ALLITERATION_CODENAMES.length;
const BUILD_CODENAME = ALLITERATION_CODENAMES[codenameIndex] ?? 'Mellow Marmot';
const BUILD_LABEL = `${BUILD_CODENAME} (${BUILD_ID})`;
const MANIFEST_NAME = `Blackiya [${BUILD_CODENAME} ${BUILD_COMMIT_SHA}]`;

// See https://wxt.dev/api/config.html
export default defineConfig({
    modules: [],
    vite: () => ({
        define: {
            __BLACKIYA_BUILD_LABEL__: JSON.stringify(BUILD_LABEL),
            __BLACKIYA_BUILD_ID__: JSON.stringify(BUILD_ID),
            __BLACKIYA_BUILD_COMMIT__: JSON.stringify(BUILD_COMMIT_SHA),
            __BLACKIYA_BUILD_CREATED_AT__: JSON.stringify(BUILD_CREATED_AT),
            'globalThis.__BLACKIYA_BUILD_LABEL__': JSON.stringify(BUILD_LABEL),
            'globalThis.__BLACKIYA_BUILD_ID__': JSON.stringify(BUILD_ID),
            'globalThis.__BLACKIYA_BUILD_COMMIT__': JSON.stringify(BUILD_COMMIT_SHA),
            'globalThis.__BLACKIYA_BUILD_CREATED_AT__': JSON.stringify(BUILD_CREATED_AT),
        },
        resolve: {
            alias: {
                react: 'preact/compat',
                'react-dom': 'preact/compat',
                'react-dom/test-utils': 'preact/test-utils',
            },
        },
    }),
    outDir: 'dist',
    manifest: {
        name: MANIFEST_NAME,
        description: 'Capture and save conversation JSON from ChatGPT, Gemini, and other LLMs',
        permissions: ['storage'],
        host_permissions: [...SUPPORTED_PLATFORM_URLS],
        action: {
            default_icon: {
                '16': 'icon/16.png',
                '32': 'icon/32.png',
            },
        },
        icons: {
            '16': 'icon/16.png',
            '32': 'icon/32.png',
            '48': 'icon/48.png',
            '128': 'icon/128.png',
        },
    },
});
