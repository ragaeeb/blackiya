import {
    createHarnessConversationPayload,
    HARNESS_CONVERSATION_ID,
    type HarnessResponseMode,
} from '../harness/fixture';

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

const server = Bun.serve({
    port,
    async fetch(request) {
        const url = new URL(request.url);

        if (url.pathname === '/harness.js') {
            return new Response(clientScript, {
                headers: { 'content-type': 'application/javascript; charset=utf-8' },
            });
        }

        if (url.pathname.startsWith('/backend-api/conversation/')) {
            const conversationId = url.pathname.split('/').at(-1) ?? HARNESS_CONVERSATION_ID;
            const mode: HarnessResponseMode =
                url.searchParams.get('mode') === 'not-terminal' ? 'not-terminal' : 'success';
            return Response.json(createHarnessConversationPayload(conversationId, mode));
        }

        return new Response(await Bun.file(htmlFile).text(), {
            headers: { 'content-type': 'text/html; charset=utf-8' },
        });
    },
});

console.log(`Blackiya browser harness: http://127.0.0.1:${server.port}/c/${HARNESS_CONVERSATION_ID}`);
console.log('The harness uses a local terminal/non-terminal fixture and the v3 single-export kernel.');

await new Promise(() => {});
