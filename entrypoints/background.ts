import { browser } from 'wxt/browser';
import { createV3BackgroundMessageHandler } from '@/features/runtime/v3-background';

export const createBackgroundMessageHandler = (actionApi: Parameters<typeof createV3BackgroundMessageHandler>[0]) =>
    createV3BackgroundMessageHandler(actionApi);

export default defineBackground(() => {
    const handleMessage = createV3BackgroundMessageHandler(browser.action ?? null);
    browser.runtime.onMessage.addListener((message, sender) => handleMessage(message, sender));
});
