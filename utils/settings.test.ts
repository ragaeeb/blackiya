import { describe, expect, it, mock } from 'bun:test';
import {
    DEFAULT_EXTENSION_ENABLED,
    isExtensionEnabledValue,
    loadExtensionEnabledSetting,
    STORAGE_KEYS,
} from '@/utils/settings';

mock.module('wxt/browser', () => ({
    browser: {
        storage: {
            local: {
                get: mock(async () => ({})),
            },
        },
    },
}));

describe('settings', () => {
    describe('isExtensionEnabledValue', () => {
        it('should treat false as disabled and any other value as enabled', () => {
            expect(isExtensionEnabledValue(false)).toBe(false);
            expect(isExtensionEnabledValue(true)).toBe(true);
            expect(isExtensionEnabledValue(undefined)).toBe(true);
            expect(isExtensionEnabledValue(null)).toBe(true);
        });
    });

    describe('loadExtensionEnabledSetting', () => {
        it('should read the persisted enabled value from storage', async () => {
            const { browser } = await import('wxt/browser');
            (browser.storage.local.get as ReturnType<typeof mock>).mockImplementationOnce(async () => ({
                [STORAGE_KEYS.EXTENSION_ENABLED]: false,
            }));

            await expect(loadExtensionEnabledSetting()).resolves.toBe(false);
        });

        it('should fall back to the default when storage does not contain the setting', async () => {
            const { browser } = await import('wxt/browser');
            (browser.storage.local.get as ReturnType<typeof mock>).mockImplementationOnce(async () => ({}));

            await expect(loadExtensionEnabledSetting()).resolves.toBe(DEFAULT_EXTENSION_ENABLED);
        });

        it('should fall back to the default when storage access fails', async () => {
            const { browser } = await import('wxt/browser');
            (browser.storage.local.get as ReturnType<typeof mock>).mockImplementationOnce(async () => {
                throw new Error('storage failed');
            });

            await expect(loadExtensionEnabledSetting()).resolves.toBe(DEFAULT_EXTENSION_ENABLED);
        });
    });
});
