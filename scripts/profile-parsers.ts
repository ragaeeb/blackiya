import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { extractGeminiStreamSignalsFromBuffer } from '@/utils/gemini-stream-parser';
import { extractGrokStreamSignalsFromBuffer } from '@/utils/grok-stream-parser';

const ITERATIONS = 250;

const profile = (label: string, run: () => void) => {
    const start = performance.now();
    for (let i = 0; i < ITERATIONS; i += 1) {
        run();
    }
    const elapsedMs = performance.now() - start;
    const avgMs = elapsedMs / ITERATIONS;
    const opsPerSec = (ITERATIONS / elapsedMs) * 1000;
    console.log(`${label}: total=${elapsedMs.toFixed(2)}ms avg=${avgMs.toFixed(3)}ms ops/s=${opsPerSec.toFixed(1)}`);
};

const run = async () => {
    const geminiFixture = await Bun.file(
        path.join(process.cwd(), 'data', 'gemini', 'sample_gemini_conversation.txt'),
    ).text();
    const grokFixture = `${JSON.stringify(
        await Bun.file(path.join(process.cwd(), 'data', 'grok', 'sample_grok_conversation.json')).json(),
    )}\n`;

    console.log(`Parser profile (${ITERATIONS} iterations)`);

    profile('Gemini stream parser', () => {
        extractGeminiStreamSignalsFromBuffer(geminiFixture, new Set());
    });

    profile('Grok stream parser', () => {
        extractGrokStreamSignalsFromBuffer(grokFixture, new Set());
    });
};

run().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
});
