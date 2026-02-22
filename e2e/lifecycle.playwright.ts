import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Route } from '@playwright/test';
import { chromium, expect, test } from '@playwright/test';
import type { CachedConversationRecord } from '../utils/external-api/background-hub';
import { EXTERNAL_CACHE_STORAGE_KEY } from '../utils/external-api/constants';

const extensionPath = process.env.BLACKIYA_EXTENSION_PATH;
const CHATGPT_CONVERSATION_ID = '696bc3d5-fa84-8328-b209-4d65cb229e59';
const GEMINI_CONVERSATION_ID = '9cf87bbddf79d497';
const GROK_CONVERSATION_ID = '01cb0729-6455-471d-b33a-124b3de76a29';

const createHarnessHtml = (title: string) => `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${title}</title>
  </head>
  <body>
    <main id="app">${title}</main>
  </body>
</html>`;

type HeadersLike = Record<string, string>;

const launchContext = async () =>
    chromium.launchPersistentContext('', {
        headless: true,
        args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    });

const resolveExtensionWorker = async (context: Awaited<ReturnType<typeof launchContext>>) => {
    return (
        context.serviceWorkers()[0] ??
        (await context.waitForEvent('serviceworker', {
            timeout: 10_000,
        }))
    );
};

const fulfillJson = async (route: Route, body: string, status = 200, headers: HeadersLike = {}) => {
    await route.fulfill({
        status,
        body,
        headers: {
            'content-type': 'application/json; charset=utf-8',
            ...headers,
        },
    });
};

const isCachedConversationRecord = (record: unknown): record is CachedConversationRecord => {
    if (!record || typeof record !== 'object') {
        return false;
    }
    const candidate = record as CachedConversationRecord;
    return (
        typeof candidate.conversation_id === 'string' &&
        typeof candidate.provider === 'string' &&
        !!candidate.payload &&
        typeof candidate.payload === 'object' &&
        typeof candidate.ts === 'number' &&
        !!candidate.capture_meta &&
        typeof candidate.capture_meta === 'object' &&
        (candidate.content_hash === null || typeof candidate.content_hash === 'string')
    );
};

const readExternalCacheRecords = async (
    worker: Awaited<ReturnType<typeof resolveExtensionWorker>>,
): Promise<CachedConversationRecord[]> => {
    const raw = await worker.evaluate(async (storageKey: string) => {
        const chromeApi = (globalThis as { chrome?: { storage: { local: { get: (key: string) => Promise<any> } } } })
            .chrome;
        if (!chromeApi) {
            return null;
        }
        const result = await chromeApi.storage.local.get(storageKey);
        return result[storageKey];
    }, EXTERNAL_CACHE_STORAGE_KEY);

    if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { records?: unknown[] }).records)) {
        return [];
    }

    return (raw as { records: unknown[] }).records.filter(isCachedConversationRecord);
};

const waitForCachedConversation = async (
    worker: Awaited<ReturnType<typeof resolveExtensionWorker>>,
    conversationId: string,
) => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        const records = await readExternalCacheRecords(worker);
        const match = records.find((record) => record.conversation_id === conversationId);
        if (match) {
            return match;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`Timed out waiting for cached external conversation record: ${conversationId}`);
};

test.describe('blackiya lifecycle capture harness', () => {
    test.skip(!extensionPath, 'Set BLACKIYA_EXTENSION_PATH to run extension lifecycle tests');

    let chatGptCanonicalResponse = '';
    let chatGptSseResponse = '';
    let geminiStreamResponse = '';
    let grokLoadResponsesResponse = '';

    test.beforeAll(async () => {
        const chatGptRaw = await readFile(
            path.join(process.cwd(), 'data', 'chatgpt', 'sample_chatgpt_conversation.json'),
            'utf8',
        );
        const chatGptParsed = JSON.parse(chatGptRaw) as { conversation_id?: string };
        chatGptParsed.conversation_id = CHATGPT_CONVERSATION_ID;
        chatGptCanonicalResponse = JSON.stringify(chatGptParsed);

        chatGptSseResponse = [
            `data: {"conversation_id":"${CHATGPT_CONVERSATION_ID}","message":{"author":{"role":"assistant"},"content":{"parts":["Hello from ChatGPT stream"]}}}`,
            '',
            'data: [DONE]',
            '',
        ].join('\n');

        geminiStreamResponse = await readFile(
            path.join(process.cwd(), 'data', 'gemini', 'sample_gemini_conversation.txt'),
            'utf8',
        );

        grokLoadResponsesResponse = JSON.stringify({
            responses: [
                {
                    responseId: 'grok-user-1',
                    createTime: '2026-02-20T00:00:00.000Z',
                    message: 'hello',
                    sender: 'human',
                    partial: false,
                },
                {
                    responseId: 'grok-assistant-1',
                    parentResponseId: 'grok-user-1',
                    createTime: '2026-02-20T00:00:01.000Z',
                    message: 'ready response from grok',
                    sender: 'assistant',
                    model: 'grok-4',
                    partial: false,
                },
            ],
        });
    });

    test('should capture ChatGPT lifecycle from streaming to canonical_ready', async () => {
        const context = await launchContext();
        try {
            const extensionWorker = await resolveExtensionWorker(context);
            const page = await context.newPage();

            await page.route('https://chatgpt.com/**', async (route) => {
                const request = route.request();
                const { pathname } = new URL(request.url());

                if (request.resourceType() === 'document' && pathname === `/c/${CHATGPT_CONVERSATION_ID}`) {
                    await route.fulfill({
                        status: 200,
                        body: createHarnessHtml('ChatGPT Harness'),
                        headers: { 'content-type': 'text/html; charset=utf-8' },
                    });
                    return;
                }

                if (pathname === '/backend-api/f/conversation') {
                    await route.fulfill({
                        status: 200,
                        body: chatGptSseResponse,
                        headers: { 'content-type': 'text/event-stream; charset=utf-8' },
                    });
                    return;
                }

                if (pathname === `/backend-api/conversation/${CHATGPT_CONVERSATION_ID}`) {
                    await fulfillJson(route, chatGptCanonicalResponse);
                    return;
                }

                await route.fulfill({ status: 204, body: '' });
            });

            await page.goto(`https://chatgpt.com/c/${CHATGPT_CONVERSATION_ID}`);

            await page.evaluate(async (conversationId: string) => {
                await fetch('/backend-api/f/conversation', {
                    method: 'POST',
                    credentials: 'include',
                    body: JSON.stringify({ conversation_id: conversationId }),
                });
                await fetch(`/backend-api/conversation/${conversationId}`, {
                    method: 'GET',
                    credentials: 'include',
                });
            }, CHATGPT_CONVERSATION_ID);

            const cached = await waitForCachedConversation(extensionWorker, CHATGPT_CONVERSATION_ID);
            expect(cached.provider).toBe('chatgpt');
            expect(cached.payload?.conversation_id).toBe(CHATGPT_CONVERSATION_ID);
        } finally {
            await context.close();
        }
    });

    test('should capture Gemini lifecycle from streaming to canonical_ready', async () => {
        const context = await launchContext();
        try {
            const extensionWorker = await resolveExtensionWorker(context);
            const page = await context.newPage();

            await page.route('https://gemini.google.com/**', async (route) => {
                const request = route.request();
                const { pathname } = new URL(request.url());

                if (request.resourceType() === 'document' && pathname === `/app/${GEMINI_CONVERSATION_ID}`) {
                    await route.fulfill({
                        status: 200,
                        body: createHarnessHtml('Gemini Harness'),
                        headers: { 'content-type': 'text/html; charset=utf-8' },
                    });
                    return;
                }

                if (pathname === '/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate') {
                    await route.fulfill({
                        status: 200,
                        body: geminiStreamResponse,
                        headers: { 'content-type': 'text/plain; charset=utf-8' },
                    });
                    return;
                }

                await route.fulfill({ status: 204, body: '' });
            });

            await page.goto(`https://gemini.google.com/app/${GEMINI_CONVERSATION_ID}`);

            await page.evaluate(async () => {
                await fetch('/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?rt=c', {
                    method: 'POST',
                    credentials: 'include',
                    body: 'stream-request',
                });
            });

            const cached = await waitForCachedConversation(extensionWorker, GEMINI_CONVERSATION_ID);
            expect(cached.provider).toBe('gemini');
            expect(cached.payload?.conversation_id).toBe(GEMINI_CONVERSATION_ID);
        } finally {
            await context.close();
        }
    });

    test('should capture Grok lifecycle from streaming to canonical_ready', async () => {
        const context = await launchContext();
        try {
            const extensionWorker = await resolveExtensionWorker(context);
            const page = await context.newPage();

            await page.route('https://grok.com/**', async (route) => {
                const request = route.request();
                const { pathname } = new URL(request.url());

                if (request.resourceType() === 'document' && pathname === `/c/${GROK_CONVERSATION_ID}`) {
                    await route.fulfill({
                        status: 200,
                        body: createHarnessHtml('Grok Harness'),
                        headers: { 'content-type': 'text/html; charset=utf-8' },
                    });
                    return;
                }

                if (pathname === '/rest/app-chat/conversations/new') {
                    await fulfillJson(route, JSON.stringify({ ok: true }));
                    return;
                }

                if (pathname === `/rest/app-chat/conversations/${GROK_CONVERSATION_ID}/load-responses`) {
                    await fulfillJson(route, grokLoadResponsesResponse);
                    return;
                }

                await route.fulfill({ status: 204, body: '' });
            });

            await page.goto(`https://grok.com/c/${GROK_CONVERSATION_ID}`);

            await page.evaluate(async (conversationId: string) => {
                await fetch('/rest/app-chat/conversations/new', {
                    method: 'POST',
                    credentials: 'include',
                    body: '{}',
                });
                await fetch(`/rest/app-chat/conversations/${conversationId}/load-responses`, {
                    method: 'GET',
                    credentials: 'include',
                });
            }, GROK_CONVERSATION_ID);

            const cached = await waitForCachedConversation(extensionWorker, GROK_CONVERSATION_ID);
            expect(cached.provider).toBe('grok');
            expect(cached.payload?.conversation_id).toBe(GROK_CONVERSATION_ID);
        } finally {
            await context.close();
        }
    });
});
