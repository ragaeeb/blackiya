import { afterEach, beforeAll, describe, expect, it, mock } from 'bun:test';

describe('bootstrap extension toggle listener', () => {
    beforeAll(() => {
        (globalThis as any).defineContentScript = (config: unknown) => config;
    });

    afterEach(() => {
        delete (globalThis as any).defineContentScript;
    });

    it('should not throw when storage.onChanged is unavailable', async () => {
        const { registerExtensionEnabledStorageListener } = await import('@/entrypoints/interceptor/bootstrap');

        expect(() => registerExtensionEnabledStorageListener(undefined, mock(() => {}) as any)).not.toThrow();
    });

    it('should register the listener when storage.onChanged exists', async () => {
        const { registerExtensionEnabledStorageListener } = await import('@/entrypoints/interceptor/bootstrap');
        const addListener = mock(() => {});

        registerExtensionEnabledStorageListener(
            {
                onChanged: {
                    addListener,
                },
            } as any,
            mock(() => {}) as any,
        );

        expect(addListener).toHaveBeenCalled();
    });
});
