import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page, Route } from '@playwright/test';
import { chromium, expect, test } from '@playwright/test';

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

type PublicStatusSnapshot = {
    platform: string | null;
    conversationId: string | null;
    attemptId: string | null;
    lifecycle: 'idle' | 'prompt-sent' | 'streaming' | 'completed';
    readiness: 'unknown' | 'awaiting_stabilization' | 'canonical_ready' | 'degraded_manual_only';
    readinessReason: string | null;
    canGetJSON: boolean;
    canGetCommonJSON: boolean;
    sequence: number;
    timestampMs: number;
};

type StatusSummary = {
    status: PublicStatusSnapshot;
    history: PublicStatusSnapshot[];
    jsonConversationId: string | null;
};

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

const waitForPublicApi = async (page: Page) => {
    await page.waitForFunction(() => Boolean((window as any).__blackiya), undefined, {
        timeout: 15_000,
    });
};

const installStatusRecorder = async (page: Page) => {
    await page.evaluate(() => {
        const api = (window as any).__blackiya;
        (window as any).__blackiyaStatusHistory = [];
        api.subscribe(
            'status',
            (status: PublicStatusSnapshot) => {
                (window as any).__blackiyaStatusHistory.push(status);
            },
            { emitCurrent: true },
        );
    });
};

const waitForCanonicalReady = async (page: Page) => {
    await page.waitForFunction(
        () => {
            const api = (window as any).__blackiya;
            if (!api) {
                return false;
            }
            const status = api.getStatus();
            return status.lifecycle === 'completed' && status.readiness === 'canonical_ready' && status.canGetJSON;
        },
        undefined,
        { timeout: 30_000 },
    );
};

const readStatusSummary = async (page: Page): Promise<StatusSummary> => {
    return await page.evaluate(async () => {
        const api = (window as any).__blackiya;
        const status = api.getStatus() as PublicStatusSnapshot;
        const history = ((window as any).__blackiyaStatusHistory ?? []) as PublicStatusSnapshot[];
        let jsonConversationId: string | null = null;

        try {
            const data = await api.getJSON();
            jsonConversationId = typeof data?.conversation_id === 'string' ? data.conversation_id : null;
        } catch {
            jsonConversationId = null;
        }

        return { status, history, jsonConversationId };
    });
};

const expectLifecycleProgression = (summary: StatusSummary) => {
    expect(summary.history.some((status) => status.lifecycle === 'streaming')).toBeTruthy();
    expect(summary.history.some((status) => status.lifecycle === 'completed')).toBeTruthy();
    expect(summary.status.lifecycle).toBe('completed');
    expect(summary.status.readiness).toBe('canonical_ready');
    expect(summary.status.canGetJSON).toBeTruthy();
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
            await resolveExtensionWorker(context);
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
            await waitForPublicApi(page);
            await installStatusRecorder(page);

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

            await waitForCanonicalReady(page);
            const summary = await readStatusSummary(page);
            expectLifecycleProgression(summary);
            expect(summary.status.platform).toBe('ChatGPT');
            expect(summary.jsonConversationId).toBe(CHATGPT_CONVERSATION_ID);
        } finally {
            await context.close();
        }
    });

    test('should capture Gemini lifecycle from streaming to canonical_ready', async () => {
        const context = await launchContext();
        try {
            await resolveExtensionWorker(context);
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
            await waitForPublicApi(page);
            await installStatusRecorder(page);

            await page.evaluate(async () => {
                await fetch('/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?rt=c', {
                    method: 'POST',
                    credentials: 'include',
                    body: 'stream-request',
                });
            });

            await waitForCanonicalReady(page);
            const summary = await readStatusSummary(page);
            expectLifecycleProgression(summary);
            expect(summary.status.platform).toBe('Gemini');
            expect(summary.jsonConversationId).toBe(GEMINI_CONVERSATION_ID);
        } finally {
            await context.close();
        }
    });

    test('should capture Grok lifecycle from streaming to canonical_ready', async () => {
        const context = await launchContext();
        try {
            await resolveExtensionWorker(context);
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
            await waitForPublicApi(page);
            await installStatusRecorder(page);

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

            await waitForCanonicalReady(page);
            const summary = await readStatusSummary(page);
            expectLifecycleProgression(summary);
            expect(summary.status.platform).toBe('Grok');
            expect(summary.jsonConversationId).toBe(GROK_CONVERSATION_ID);
        } finally {
            await context.close();
        }
    });
});
