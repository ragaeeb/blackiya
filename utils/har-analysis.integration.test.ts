import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { analyzeHarContent } from '@/utils/har-analysis';

describe('har-analysis (integration fixture)', () => {
    it('should detect grok streaming endpoints and thinking hints from minimal HAR fixture', () => {
        const fixturePath = path.resolve(process.cwd(), 'tests/fixtures/grok.minimal.har.json');
        const rawHar = readFileSync(fixturePath, 'utf8');

        const analysis = analyzeHarContent(rawHar, {
            hostFilter: ['grok.com'],
            hints: [
                'I have the full text broken into segments P101391 to P101395a.',
                'Here is the full accurate translation following all the specified rules for the segments.',
            ],
            sourceFile: fixturePath,
        });

        expect(analysis.stats.entriesScanned).toBeGreaterThanOrEqual(4);
        expect(analysis.likelyStreamingEndpoints.some((endpoint) => endpoint.path.includes('/conversations/new'))).toBe(
            true,
        );
        expect(
            analysis.likelyStreamingEndpoints.some((endpoint) => endpoint.path.includes('/reconnect-response-v2/')),
        ).toBe(true);
        expect(analysis.likelyStreamingEndpoints.some((endpoint) => endpoint.path.includes('/load-responses'))).toBe(
            true,
        );
        expect(analysis.stats.reasoningSignalEvents).toBeGreaterThan(0);
        expect(analysis.hintMatches.length).toBeGreaterThan(0);
    });
});
