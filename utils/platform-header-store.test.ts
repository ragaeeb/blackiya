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

    it('should clear all stored headers', () => {
        const store = new PlatformHeaderStore();
        store.update('ChatGPT', { authorization: 'Bearer abc' });
        store.update('Gemini', { 'x-key': 'val' });
        store.clear();
        expect(store.get('ChatGPT')).toBeUndefined();
        expect(store.get('Gemini')).toBeUndefined();
    });
});
