/**
 * Integration tests for minimal debug report generation using realistic exported log streams.
 */

import { describe, expect, it } from 'bun:test';
import type { LogEntry } from './logs-storage';
import { generateMinimalDebugReport } from './minimal-logs';

describe('Minimal Debug Report Integration', () => {
    it('should include diagnostics for ChatGPT runs with no interception session', () => {
        const logs: LogEntry[] = [
            {
                timestamp: '2026-02-13T22:27:13.151Z',
                level: 'info',
                context: 'content',
                message: 'Content script running for ChatGPT',
                data: [],
            },
            {
                timestamp: '2026-02-13T22:27:13.152Z',
                level: 'info',
                context: 'content',
                message: 'NavigationManager started',
                data: [],
            },
            {
                timestamp: '2026-02-13T22:27:25.854Z',
                level: 'info',
                context: 'content',
                message: 'Save/Copy buttons injected for conversation: 698fa54b-9004-8326-a25a-d9e8f90b7fbc',
                data: [],
            },
        ];

        const report = generateMinimalDebugReport(logs);

        expect(report).toContain('No interception sessions');
        expect(report).toContain('## Diagnostics');
        expect(report).toContain('Content script running for ChatGPT');
        expect(report).toContain('Save/Copy buttons injected for conversation: 698fa54b-9004-8326-a25a-d9e8f90b7fbc');
    });

    it('should still prefer interception sessions when they exist', () => {
        const logs: LogEntry[] = [
            {
                timestamp: '2026-02-13T22:27:13.151Z',
                level: 'info',
                context: 'content',
                message: 'Content script running for ChatGPT',
                data: [],
            },
            {
                timestamp: '2026-02-13T22:27:26.100Z',
                level: 'info',
                context: 'content',
                message: '[i] API match ChatGPT',
                data: [],
            },
            {
                timestamp: '2026-02-13T22:27:26.500Z',
                level: 'info',
                context: 'content',
                message: 'Successfully captured/cached data for conversation: 698fa54b-9004-8326-a25a-d9e8f90b7fbc',
                data: [],
            },
        ];

        const report = generateMinimalDebugReport(logs);

        expect(report).toContain('Sessions: 1');
        expect(report).toContain('API match ChatGPT');
        expect(report).not.toContain('## Diagnostics');
    });
});
