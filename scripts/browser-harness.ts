import {
    createHarnessConversationPayload,
    createHarnessConversationListPayload,
    HARNESS_CONVERSATION_ID,
    isValidHarnessAuthorization,
    type HarnessResponseMode,
} from '../harness/fixture';
import {
    DEFAULT_RELAY_URL,
    parseRelayNdjson,
    sanitizeRelayEvent,
    type RelayEvent,
} from '../harness/relay';

const htmlFile = new URL('../harness/index.html', import.meta.url);
const clientEntry = new URL('../harness/main.ts', import.meta.url);
const buildResult = await Bun.build({
    entrypoints: [clientEntry.pathname],
    format: 'esm',
    minify: false,
    sourcemap: 'inline',
    target: 'browser',
});

if (!buildResult.success) {
    for (const log of buildResult.logs) {
        console.error(log);
    }
    process.exit(1);
}

const clientScript = await buildResult.outputs[0]!.text();
const port = Number(Bun.env.BLACKIYA_HARNESS_PORT ?? 4177);
const args = Bun.argv.slice(2);
const relayEnabled = args.includes('--relay');
const outputArgumentIndex = args.indexOf('--output');
const relayOutputPath =
    outputArgumentIndex >= 0 && typeof args[outputArgumentIndex + 1] === 'string'
        ? args[outputArgumentIndex + 1]
        : Bun.env.BLACKIYA_RELAY_OUTPUT?.trim() || null;
const relayEvents: RelayEvent[] = [];
let relayWrite = Promise.resolve();

const unauthorizedResponse = () => Response.json({ error: 'missing_auth' }, { status: 401 });

const isAuthorizedFixtureRequest = (request: Request): boolean =>
    isValidHarnessAuthorization(request.headers.get('authorization'));

const resolveResponseMode = (url: URL): HarnessResponseMode => {
    const mode = url.searchParams.get('mode');
    return mode === 'not-terminal' || mode === 'multimodal' ? mode : 'success';
};

const persistRelayEvents = async () => {
    if (!relayOutputPath) {
        return;
    }
    await Bun.write(relayOutputPath, `${relayEvents.map((event) => JSON.stringify(event)).join('\n')}\n`);
};

const recordRelayEvents = async (events: RelayEvent[]) => {
    if (events.length === 0) {
        return;
    }
    relayEvents.push(...events);
    if (relayEvents.length > 10_000) {
        relayEvents.splice(0, relayEvents.length - 10_000);
    }
    relayWrite = relayWrite.then(persistRelayEvents);
    await relayWrite;
};

const requireFixtureAuth = (request: Request, handler: () => Response): Response =>
    isAuthorizedFixtureRequest(request) ? handler() : unauthorizedResponse();

const parseRelayRequestBody = (body: string): RelayEvent[] => {
    if (!body.trim().startsWith('{')) {
        return parseRelayNdjson(body);
    }
    try {
        const event = sanitizeRelayEvent(JSON.parse(body));
        return event ? [event] : [];
    } catch {
        return [];
    }
};

const handleRelayRequest = async (request: Request): Promise<Response> => {
    if (!relayEnabled) {
        return Response.json({ error: 'relay_disabled' }, { status: 404 });
    }
    if (request.method === 'GET') {
        return Response.json(relayEvents);
    }
    if (request.method !== 'POST') {
        return new Response('Method Not Allowed', { status: 405 });
    }
    const events = parseRelayRequestBody(await request.text());
    await recordRelayEvents(events);
    return Response.json({ ok: true, accepted: events.length });
};

const handleProviderRequest = (request: Request, url: URL): Response | null => {
    if (url.pathname.startsWith('/backend-api/conversation/')) {
        return requireFixtureAuth(request, () => {
            const conversationId = url.pathname.split('/').at(-1) ?? HARNESS_CONVERSATION_ID;
            return Response.json(createHarnessConversationPayload(conversationId, resolveResponseMode(url)));
        });
    }
    if (url.pathname === '/backend-api/conversations') {
        return requireFixtureAuth(request, () => Response.json(createHarnessConversationListPayload()));
    }
    if (url.pathname === '/backend-api/f/conversation') {
        return requireFixtureAuth(
            request,
            () =>
                new Response(
                    'data: {"delta":"fixture"}\n\ndata: {"finish_reason":"refusal"}\n\ndata: {"action":"erase_previous_tokens"}\n\ndata: [DONE]\n\n',
                    {
                        headers: {
                            'cache-control': 'no-cache',
                            'content-type': 'text/event-stream; charset=utf-8',
                        },
                    },
                ),
        );
    }
    return null;
};

const server = Bun.serve({
    hostname: '127.0.0.1',
    port,
    async fetch(request) {
        const url = new URL(request.url);

        if (url.pathname === '/harness.js') {
            return new Response(clientScript, {
                headers: { 'content-type': 'application/javascript; charset=utf-8' },
            });
        }

        if (url.pathname === '/events') {
            return handleRelayRequest(request);
        }

        const providerResponse = handleProviderRequest(request, url);
        if (providerResponse) {
            return providerResponse;
        }

        return new Response(await Bun.file(htmlFile).text(), {
            headers: { 'content-type': 'text/html; charset=utf-8' },
        });
    },
});

console.log(`Blackiya browser harness: http://127.0.0.1:${server.port}/c/${HARNESS_CONVERSATION_ID}`);
console.log('The harness uses a strict local ChatGPT fixture and the v3 single-export kernel.');
if (relayEnabled) {
    console.log(`Dev relay collector: ${DEFAULT_RELAY_URL.replace('4177', String(server.port))}`);
    if (relayOutputPath) {
        console.log(`Dev relay output: ${relayOutputPath}`);
    }
} else {
    console.log('Dev relay collector disabled; pass --relay to enable localhost event collection.');
}

await new Promise(() => {});
