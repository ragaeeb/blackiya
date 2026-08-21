import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { Window } from 'happy-dom';
import { render } from 'preact';
import { DEFAULT_BULK_EXPORT_DELAY_MS, DEFAULT_BULK_EXPORT_TIMEOUT_MS } from '@/utils/settings';

type SendCall = { tabId: number; message: Record<string, unknown> };

const state = {
    storageData: {} as Record<string, unknown>,
    storageSets: [] as Array<Record<string, unknown>>,
    sendCalls: [] as SendCall[],
    downloadCalls: [] as Array<{ data: unknown; filename: string }>,
    downloadResult: true,
    sendResponse: undefined as unknown | undefined,
    sendShouldThrow: false as unknown | false,
};

const downloadAsJSONMock = mock((data: unknown, filename: string) => {
    state.downloadCalls.push({ data, filename });
    return state.downloadResult;
});

mock.module('wxt/browser', () => ({
    browser: {
        storage: {
            local: {
                get: async (keys: string | string[]) => {
                    const requested = typeof keys === 'string' ? [keys] : keys;
                    const out: Record<string, unknown> = {};
                    for (const key of requested) {
                        if (key in state.storageData) {
                            out[key] = state.storageData[key];
                        }
                    }
                    return out;
                },
                set: async (values: Record<string, unknown>) => {
                    state.storageSets.push(values);
                },
                remove: async () => {},
            },
        },
        runtime: {
            getManifest: () => ({ version: '9.9.9' }),
            getURL: (path: string) => `chrome-extension://mock/${path}`,
        },
        tabs: {
            query: async () => [{ id: 42 }],
            sendMessage: async (tabId: number, message: Record<string, unknown>) => {
                state.sendCalls.push({ tabId, message });
                if (state.sendShouldThrow !== false) {
                    throw state.sendShouldThrow;
                }
                return state.sendResponse;
            },
        },
    },
}));

mock.module('@/utils/download', () => ({
    downloadAsJSON: downloadAsJSONMock,
    generateTimestamp: () => '2026-08-21_00-00-00',
}));

import App from './App';
import { V3_CLEAR_STREAM_DEBUG_MESSAGE, V3_EXPORT_CHATS_MESSAGE, V3_EXPORT_STREAM_DEBUG_MESSAGE } from './v3-messaging';

const flush = async (rounds = 4) => {
    for (let i = 0; i < rounds; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
};

const settleEffects = async () => {
    await new Promise((resolve) => setTimeout(resolve, 80));
};

describe('popup v3 controls', () => {
    let windowInstance: Window;
    let previousWindow: unknown;
    let previousDocument: unknown;
    let mountedContainer: HTMLElement | null = null;

    beforeEach(() => {
        const globalRecord = globalThis as Record<string, unknown>;
        previousWindow = globalRecord.window;
        previousDocument = globalRecord.document;
        windowInstance = new Window();
        globalRecord.window = windowInstance;
        globalRecord.document = windowInstance.document;
        windowInstance.document.body.innerHTML = '';
        state.storageData = {};
        state.storageSets = [];
        state.sendCalls = [];
        state.downloadCalls = [];
        state.downloadResult = true;
        downloadAsJSONMock.mockClear();
        state.sendResponse = undefined;
        state.sendShouldThrow = false;
    });

    afterEach(() => {
        if (mountedContainer) {
            render(null, mountedContainer);
            mountedContainer = null;
        }
        const globalRecord = globalThis as Record<string, unknown>;
        if (previousWindow === undefined) {
            delete globalRecord.window;
        } else {
            globalRecord.window = previousWindow;
        }
        if (previousDocument === undefined) {
            delete globalRecord.document;
        } else {
            globalRecord.document = previousDocument;
        }
    });

    const renderApp = async () => {
        const container = document.createElement('div');
        document.body.appendChild(container);
        mountedContainer = container;
        render(<App />, container);
        await settleEffects();
        await flush(1);
        return container;
    };

    const findButtonByLabel = (container: HTMLElement, label: string): HTMLButtonElement | null => {
        const buttons = Array.from(container.querySelectorAll('button'));
        return buttons.find((button) => button.textContent?.includes(label)) ?? null;
    };

    it('should render exactly the descoped-free control inventory', async () => {
        const container = await renderApp();

        expect(findButtonByLabel(container, 'Export Chats')).toBeTruthy();
        expect(findButtonByLabel(container, 'Export Stream Debug')).toBeTruthy();
        expect(findButtonByLabel(container, 'Clear Stream Debug')).toBeTruthy();

        expect(container.querySelector('#bulkExportLimit')).toBeTruthy();
        expect(container.querySelector('[role="status"]')).toBeTruthy();
        expect(container.textContent).toContain('Blackiya v9.9.9');

        expect(container.querySelectorAll('select').length).toBe(0);
        expect(container.querySelector('#extensionEnabled')).toBeNull();
        expect(findButtonByLabel(container, 'Full')).toBeNull();
        expect(findButtonByLabel(container, 'Debug TXT')).toBeNull();
        expect(container.textContent).not.toContain('Calibrate');
        expect(container.textContent).not.toContain('SFE');
        expect(container.textContent).not.toContain('Stream Probe');
        expect(container.textContent).not.toContain('Markdown');
        expect(container.textContent).not.toContain('Log Level');
    });

    it('should show a concise status region without noise', async () => {
        const container = await renderApp();
        const status = container.querySelector('[role="status"]');
        expect(status).toBeTruthy();
        expect(status?.textContent).toBe('');
    });

    it('should send the v3 bulk export message to the active tab with normalized limit', async () => {
        state.sendResponse = {
            ok: true,
            result: { platform: 'chatgpt', attempted: 2, exported: 2, warnings: [] },
        };

        const container = await renderApp();
        const input = container.querySelector('#bulkExportLimit') as HTMLInputElement;
        const inputWindow = windowInstance as unknown as typeof globalThis & { Event: typeof Event };
        input.value = '5';
        input.dispatchEvent(new inputWindow.Event('input', { bubbles: true }));
        input.dispatchEvent(new inputWindow.Event('change', { bubbles: true }));
        await flush(1);

        const button = findButtonByLabel(container, 'Export Chats') as HTMLButtonElement;
        button.click();
        await flush();

        expect(state.sendCalls.length).toBe(1);
        expect(state.sendCalls[0]).toEqual({
            tabId: 42,
            message: {
                type: V3_EXPORT_CHATS_MESSAGE,
                limit: 5,
                delayMs: DEFAULT_BULK_EXPORT_DELAY_MS,
                timeoutMs: DEFAULT_BULK_EXPORT_TIMEOUT_MS,
            },
        });
        expect(container.querySelector('[role="status"]')?.textContent).toBe('Exported 2/2 chats on chatgpt.');
        expect(button.disabled).toBe(false);
    });

    it('should surface bulk export errors concisely', async () => {
        state.sendResponse = { ok: false, error: 'Unsupported page.' };

        const container = await renderApp();
        const button = findButtonByLabel(container, 'Export Chats') as HTMLButtonElement;
        button.click();
        await flush();

        expect(container.querySelector('[role="status"]')?.textContent).toBe('Export failed: Unsupported page.');
    });

    it('should disable the export button while a bulk export is in flight', async () => {
        let release!: (value: unknown) => void;
        const pending = new Promise<unknown>((resolve) => {
            release = resolve;
        });
        state.sendResponse = pending;

        const container = await renderApp();
        const button = findButtonByLabel(container, 'Export Chats') as HTMLButtonElement;
        button.click();
        await flush(1);

        expect(button.disabled).toBe(true);
        expect(button.textContent).toContain('Exporting Chats');

        release({ ok: true, result: null });
        await flush();

        expect(button.disabled).toBe(false);
    });

    it('should send the stream debug export message and report success', async () => {
        const records = [{ streamId: 'stream-1', frames: [{ text: 'data: hello' }] }];
        state.sendResponse = { ok: true, result: records };

        const container = await renderApp();
        const button = findButtonByLabel(container, 'Export Stream Debug') as HTMLButtonElement;
        button.click();
        await flush();

        expect(state.sendCalls.length).toBe(1);
        expect(state.sendCalls[0]).toEqual({ tabId: 42, message: { type: V3_EXPORT_STREAM_DEBUG_MESSAGE } });
        expect(state.downloadCalls).toEqual([
            {
                data: records,
                filename: expect.stringMatching(/^blackiya-stream-debug-.*$/),
            },
        ]);
        expect(container.querySelector('[role="status"]')?.textContent).toBe('Stream debug exported.');
    });

    it('should download an empty JSON array when no stream-debug records are captured', async () => {
        state.sendResponse = { ok: true, result: [] };

        const container = await renderApp();
        const button = findButtonByLabel(container, 'Export Stream Debug') as HTMLButtonElement;
        button.click();
        await flush();

        expect(state.downloadCalls).toEqual([
            {
                data: [],
                filename: expect.stringMatching(/^blackiya-stream-debug-.*$/),
            },
        ]);
        expect(container.querySelector('[role="status"]')?.textContent).toBe('Stream debug exported.');
    });

    it('should surface stream debug download failures instead of reporting success', async () => {
        state.sendResponse = { ok: true, result: [] };
        state.downloadResult = false;

        const container = await renderApp();
        const button = findButtonByLabel(container, 'Export Stream Debug') as HTMLButtonElement;
        button.click();
        await flush();

        expect(container.querySelector('[role="status"]')?.textContent).toBe(
            'Stream debug export failed: Could not download stream debug JSON.',
        );
    });

    it('should send the stream debug clear message and report success', async () => {
        state.sendResponse = { ok: true };

        const container = await renderApp();
        const button = findButtonByLabel(container, 'Clear Stream Debug') as HTMLButtonElement;
        button.click();
        await flush();

        expect(state.sendCalls.length).toBe(1);
        expect(state.sendCalls[0]).toEqual({ tabId: 42, message: { type: V3_CLEAR_STREAM_DEBUG_MESSAGE } });
        expect(container.querySelector('[role="status"]')?.textContent).toBe('Stream debug cleared.');
    });

    it('should surface stream debug failures concisely', async () => {
        state.sendResponse = { ok: false, error: 'Stream debug unavailable.' };

        const container = await renderApp();
        const button = findButtonByLabel(container, 'Export Stream Debug') as HTMLButtonElement;
        button.click();
        await flush();

        expect(container.querySelector('[role="status"]')?.textContent).toBe(
            'Stream debug export failed: Stream debug unavailable.',
        );
    });

    it('should load the persisted max-chat limit into the input', async () => {
        state.storageData = { 'userSettings.bulkExport.limit': 25 };

        const container = await renderApp();
        const input = container.querySelector('#bulkExportLimit') as HTMLInputElement;

        expect(input.value).toBe('25');
    });
});
