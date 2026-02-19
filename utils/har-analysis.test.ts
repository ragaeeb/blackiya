import { describe, expect, it } from 'bun:test';

import { analyzeHarContent, renderHarAnalysisMarkdown } from '@/utils/har-analysis';

const SAMPLE_HAR = {
    log: {
        entries: [
            {
                startedDateTime: '2026-02-18T17:02:00.100Z',
                time: 87,
                request: {
                    method: 'POST',
                    url: 'https://grok.com/rest/app-chat/conversations/new?rid=abc123&token=super-secret',
                    headers: [
                        { name: 'Content-Type', value: 'application/json' },
                        { name: 'Authorization', value: 'Bearer super-secret-token' },
                    ],
                    postData: {
                        mimeType: 'application/json',
                        text: '{"prompt":"Agents thinking should be visible"}',
                    },
                },
                response: {
                    status: 200,
                    headers: [{ name: 'Content-Type', value: 'application/x-ndjson' }],
                    content: {
                        mimeType: 'application/x-ndjson',
                        text: '{"isThinking":true,"token":"I have the full text broken into segments P101391 to P101395a."}\n{"message":"chunk"}\n',
                    },
                },
            },
            {
                startedDateTime: '2026-02-18T17:02:00.900Z',
                time: 39,
                request: {
                    method: 'GET',
                    url: 'https://grok.com/rest/app-chat/reconnect-response-v2?conversationId=cid-1',
                },
                response: {
                    status: 200,
                    headers: [{ name: 'Content-Type', value: 'application/json' }],
                    content: {
                        mimeType: 'application/json',
                        encoding: 'base64',
                        text: Buffer.from(
                            '{"thinking_trace":"Here is the full accurate translation following all the specified rules."}',
                            'utf8',
                        ).toString('base64'),
                    },
                },
            },
            {
                startedDateTime: '2026-02-18T17:02:01.010Z',
                request: {
                    method: 'GET',
                    url: 'https://cdn.example.com/assets/app.js',
                },
                response: {
                    status: 200,
                    content: {
                        mimeType: 'application/javascript',
                        text: 'console.log("noop");',
                    },
                },
            },
        ],
    },
};

describe('har-analysis', () => {
    it('should redact sensitive values and classify stream-like endpoints', () => {
        const analysis = analyzeHarContent(JSON.stringify(SAMPLE_HAR), {
            hints: ['Agents thinking', 'I have the full text broken into segments P101391 to P101395a.'],
            hostFilter: ['grok.com'],
            sourceFile: '/tmp/grok.com.har',
        });

        expect(analysis.stats.totalEntries).toBe(3);
        expect(analysis.stats.entriesScanned).toBe(2);
        expect(analysis.stats.entriesFilteredOut).toBe(1);
        expect(analysis.stats.bodyTruncationCount).toBe(0);

        const firstEvent = analysis.timeline[0];
        expect(firstEvent.url).toContain('token=%5BREDACTED%5D');
        expect(firstEvent.requestHeaders.authorization).toBe('[REDACTED]');
        expect(firstEvent.streamLikely).toBe(true);
        expect(firstEvent.reasoningSignals).toContain('isThinking');

        expect(analysis.likelyStreamingEndpoints.some((endpoint) => endpoint.path.includes('/conversations/new'))).toBe(
            true,
        );
    });

    it('should extract hint matches from request and base64 response payloads', () => {
        const analysis = analyzeHarContent(JSON.stringify(SAMPLE_HAR), {
            hints: [
                'Agents thinking',
                'I have the full text broken into segments P101391 to P101395a.',
                'Here is the full accurate translation following all the specified rules.',
            ],
            hostFilter: ['grok.com'],
        });

        const matchedHints = new Set(analysis.hintMatches.map((match) => match.hint));
        expect(matchedHints.has('Agents thinking')).toBe(true);
        expect(matchedHints.has('I have the full text broken into segments P101391 to P101395a.')).toBe(true);
        expect(matchedHints.has('Here is the full accurate translation following all the specified rules.')).toBe(true);

        const responseMatch = analysis.hintMatches.find((match) => match.hint.includes('full accurate translation'));
        expect(responseMatch?.phase).toBe('response');
        expect(responseMatch?.path).toBe('/rest/app-chat/reconnect-response-v2');
    });

    it('should cap matches per hint and render a markdown report', () => {
        const repeatedHar = {
            log: {
                entries: [
                    {
                        request: {
                            method: 'POST',
                            url: 'https://grok.com/a',
                            postData: { text: 'repeat repeat repeat' },
                        },
                        response: {
                            status: 200,
                            content: { mimeType: 'application/json', text: '{"message":"repeat"}' },
                        },
                    },
                    {
                        request: { method: 'POST', url: 'https://grok.com/b', postData: { text: 'repeat' } },
                        response: {
                            status: 200,
                            content: { mimeType: 'application/json', text: '{"message":"repeat"}' },
                        },
                    },
                ],
            },
        };

        const analysis = analyzeHarContent(JSON.stringify(repeatedHar), {
            hints: ['repeat'],
            maxMatchesPerHint: 2,
            hostFilter: ['grok.com'],
        });

        expect(analysis.hintMatches.length).toBe(2);

        const report = renderHarAnalysisMarkdown(analysis);
        expect(report).toContain('# HAR Discovery Analysis');
        expect(report).toContain('## Likely Streaming Endpoints');
        expect(report).toContain('## Hint Matches');
    });

    it('should track body truncation count when maxBodyChars clips payloads', () => {
        const longBodyHar = {
            log: {
                entries: [
                    {
                        request: {
                            method: 'POST',
                            url: 'https://grok.com/long',
                            postData: { text: 'a'.repeat(200) },
                        },
                        response: {
                            status: 200,
                            content: { mimeType: 'application/json', text: JSON.stringify({ text: 'b'.repeat(200) }) },
                        },
                    },
                ],
            },
        };
        const analysis = analyzeHarContent(JSON.stringify(longBodyHar), {
            hostFilter: ['grok.com'],
            maxBodyChars: 80,
            hints: ['zzzz'],
        });

        expect(analysis.stats.bodyTruncationCount).toBe(2);
        expect(analysis.hintMatches.length).toBe(0);
    });

    it('should throw for malformed HAR payloads', () => {
        expect(() => analyzeHarContent('{"log":{"entries":"oops"}}')).toThrow(
            'Invalid HAR: expected log.entries to be an array',
        );
    });
});
