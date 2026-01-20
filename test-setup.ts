import { mock } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

GlobalRegistrator.register();

// Mock wxt/browser
const storageMock = {
    local: {
        get: async () => ({}),
        set: async () => {},
        remove: async () => {},
    },
};

const browserMock = {
    storage: storageMock,
    runtime: {
        getURL: (path: string) => `chrome-extension://mock/${path}`,
    },
};

mock.module('wxt/browser', () => ({
    browser: browserMock,
}));

(global as any).browser = browserMock;

// Mock logger globally to prevent storage writes during tests
mock.module('@/utils/logger', () => ({
    logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
    },
}));
