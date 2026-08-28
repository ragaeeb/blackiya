import { describe, expect, it } from 'bun:test';

import { PlatformHeaderStore } from '@/utils/platform-header-store';

describe('PlatformHeaderStore', () => {
    it('should store and retrieve headers by platform name', () => {
        const store = new PlatformHeaderStore();
        store.update('ChatGPT', { authorization: 'Bearer abc', 'oai-device-id': 'dev-1' });
        expect(store.get('ChatGPT')).toEqual({ authorization: 'Bearer abc', 'oai-device-id': 'dev-1' });
    });

    it('should return undefined for unknown platforms', () => {
        const store = new PlatformHeaderStore();
        expect(store.get('Unknown')).toBeUndefined();
    });

    it('should merge incoming headers with existing ones', () => {
        const store = new PlatformHeaderStore();
        store.update('ChatGPT', { authorization: 'Bearer abc' });
        store.update('ChatGPT', { 'oai-device-id': 'dev-1' });
        expect(store.get('ChatGPT')).toEqual({ authorization: 'Bearer abc', 'oai-device-id': 'dev-1' });
    });

    it('should overwrite existing header values with newer ones', () => {
        const store = new PlatformHeaderStore();
        store.update('ChatGPT', { authorization: 'Bearer old' });
        store.update('ChatGPT', { authorization: 'Bearer new' });
        expect(store.get('ChatGPT')).toEqual({ authorization: 'Bearer new' });
    });

    it('should discard stale identity headers when an account authorization changes', () => {
        const store = new PlatformHeaderStore();
        store.update('ChatGPT', { authorization: 'Bearer old', 'oai-device-id': 'device-old' });
        const identityChanged = store.update('ChatGPT', { authorization: 'Bearer new' });

        expect(identityChanged).toBeTrue();
        expect(store.get('ChatGPT')).toEqual({ authorization: 'Bearer new' });
    });

    it('should report a newly established identity boundary but not ordinary header merges', () => {
        const store = new PlatformHeaderStore();

        expect(store.update('ChatGPT', { authorization: 'Bearer same' })).toBeTrue();
        expect(store.update('ChatGPT', { 'oai-device-id': 'device-1' })).toBeFalse();
    });

    it('should report identity establishment after non-identity headers were stored first', () => {
        const store = new PlatformHeaderStore();

        expect(store.update('ChatGPT', { 'x-client-version': '1' })).toBeFalse();
        expect(store.update('ChatGPT', { authorization: 'Bearer established' })).toBeTrue();
        expect(store.get('ChatGPT')).toEqual({
            'x-client-version': '1',
            authorization: 'Bearer established',
        });
    });

    it('should discard unrelated old headers when a partial identity snapshot changes', () => {
        const store = new PlatformHeaderStore();
        store.update('ChatGPT', {
            authorization: 'Bearer old',
            'oai-device-id': 'device-old',
            'x-private-context': 'old-secret',
        });
        store.update('ChatGPT', { 'OAI-DEVICE-ID': 'device-new' });

        expect(store.get('ChatGPT')).toEqual({ 'oai-device-id': 'device-new' });
    });

    it('should return a defensive header snapshot', () => {
        const store = new PlatformHeaderStore();
        store.update('ChatGPT', { authorization: 'Bearer original' });

        const snapshot = store.get('ChatGPT');
        snapshot!.authorization = 'Bearer mutated';

        expect(store.get('ChatGPT')).toEqual({ authorization: 'Bearer original' });
    });

    it('should expire snapshots after the configured lifetime', () => {
        let now = 1_000;
        const store = new PlatformHeaderStore({ maxAgeMs: 100, now: () => now });
        store.update('ChatGPT', { authorization: 'Bearer abc' });

        now = 1_101;
        expect(store.get('ChatGPT')).toBeUndefined();
    });

    it('should ignore empty or undefined incoming headers', () => {
        const store = new PlatformHeaderStore();
        store.update('ChatGPT', { authorization: 'Bearer abc' });
        store.update('ChatGPT', undefined);
        store.update('ChatGPT', {});
        expect(store.get('ChatGPT')).toEqual({ authorization: 'Bearer abc' });
    });

    it('should keep headers per platform independently', () => {
        const store = new PlatformHeaderStore();
        store.update('ChatGPT', { authorization: 'Bearer chatgpt' });
        store.update('Gemini', { 'x-gemini-key': 'gemini-key' });
        expect(store.get('ChatGPT')).toEqual({ authorization: 'Bearer chatgpt' });
        expect(store.get('Gemini')).toEqual({ 'x-gemini-key': 'gemini-key' });
    });

    it('should clear only the provider snapshot requested', () => {
        const store = new PlatformHeaderStore();
        store.update('ChatGPT', { authorization: 'Bearer chatgpt' });
        store.update('Gemini', { authorization: 'Bearer gemini' });

        store.clear('ChatGPT');

        expect(store.get('ChatGPT')).toBeUndefined();
        expect(store.get('Gemini')).toEqual({ authorization: 'Bearer gemini' });
    });

    it('should clear all stored headers', () => {
        const store = new PlatformHeaderStore();
        store.update('ChatGPT', { authorization: 'Bearer abc' });
        store.update('Gemini', { 'x-key': 'val' });
        store.clear();
        expect(store.get('ChatGPT')).toBeUndefined();
        expect(store.get('Gemini')).toBeUndefined();
    });
});
