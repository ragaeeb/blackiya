/**
 * Tests for Minimal Logs Export
 */

import { describe, expect, it } from 'bun:test';
import type { LogEntry } from './logs-storage';
import { generateMinimalDebugReport } from './minimal-logs';

describe('Minimal Debug Report', () => {
    it('should generate report from lean interceptor logs', () => {
        const logs: LogEntry[] = [
            {
                timestamp: '',
                level: 'info',
                message: '[i] trigger ChatGPT 696bc3d5-fa84-8328-b209-4d65cb229e59',
                context: 'content',
            },
            {
                timestamp: '',
                level: 'info',
                message: '[i] fetching 696bc3d5-fa84-8328-b209-4d65cb229e59',
                context: 'content',
            },
            {
                timestamp: '',
                level: 'info',
                message: '[i] fetch 200 696bc3d5-fa84-8328-b209-4d65cb229e59',
                context: 'content',
            },
            {
                timestamp: '',
                level: 'info',
                message: '[i] fetched 696bc3d5-fa84-8328-b209-4d65cb229e59 12345b',
                context: 'content',
            },
        ];

        const report = generateMinimalDebugReport(logs);

        expect(report).toContain('# Blackiya Debug Report');
        expect(report).toContain('Sessions: 1');
        expect(report).toContain('696bc3d5');
        expect(report).toContain('trigger ChatGPT');
        expect(report).toContain('fetch 200');
        expect(report).toContain('fetched');
        expect(report).not.toContain('✅');
        expect(report).not.toContain('⚠️');
        expect(report).not.toContain('[interceptor]');
    });

    it('should dedupe sessions by platform and convId', () => {
        const logs: LogEntry[] = [];
        for (let i = 0; i < 3; i++) {
            logs.push({
                timestamp: '',
                level: 'info',
                message: '[i] trigger ChatGPT 698eb19b-1f00-832f-9f65-cc496db620c9',
                context: 'content',
            });
            logs.push({
                timestamp: '',
                level: 'info',
                message: '[i] fetching 698eb19b-1f00-832f-9f65-cc496db620c9',
                context: 'content',
            });
            logs.push({
                timestamp: '',
                level: 'info',
                message: '[i] fetch 404 698eb19b-1f00-832f-9f65-cc496db620c9',
                context: 'content',
            });
        }

        const report = generateMinimalDebugReport(logs);

        expect(report).toContain('Sessions: 1');
        expect(report).toContain('×3');
        expect(report).toContain('698eb19b');
        expect(report).toContain('fetch 404');
    });

    it('should show ERR for errors and no emoji', () => {
        const logs: LogEntry[] = [
            {
                timestamp: '',
                level: 'info',
                message: '[i] trigger ChatGPT 698eb19b-1f00-832f-9f65-cc496db620c9',
                context: 'content',
            },
            {
                timestamp: '',
                level: 'error',
                message: '[i] fetch err 698eb19b-1f00-832f-9f65-cc496db620c9',
                context: 'content',
                data: [{ message: 'AbortError' }],
            },
        ];

        const report = generateMinimalDebugReport(logs);

        expect(report).toContain('## Errors');
        expect(report).toContain('ERR');
        expect(report).toContain('fetch err');
        expect(report).not.toContain('⚠️');
    });

    it('should handle API match sessions (no convId in first line)', () => {
        const logs: LogEntry[] = [
            { timestamp: '', level: 'info', message: '[i] API match ChatGPT', context: 'content' },
            { timestamp: '', level: 'info', message: '[i] API 44272b ChatGPT', context: 'content' },
        ];

        const report = generateMinimalDebugReport(logs);

        expect(report).toContain('Sessions: 1');
        expect(report).toContain('ChatGPT');
        expect(report).toContain('API match ChatGPT');
        expect(report).toContain('API 44272b');
    });

    it('should return helpful message when no sessions', () => {
        const logs: LogEntry[] = [{ timestamp: '', level: 'info', message: 'Unrelated log', context: 'background' }];

        const report = generateMinimalDebugReport(logs);

        expect(report).toContain('No interception sessions');
    });

    it('should include fallback diagnostics when no interception sessions', () => {
        const logs: LogEntry[] = [
            {
                timestamp: '',
                level: 'info',
                message: 'Content script running for ChatGPT',
                context: 'content',
            },
            {
                timestamp: '',
                level: 'info',
                message: 'Save/Copy buttons injected for conversation: 698f9bd8-1754-832e-a2f2-10e697b65849',
                context: 'content',
            },
            {
                timestamp: '',
                level: 'info',
                message: 'Button state',
                context: 'content',
                data: [{ conversationId: '698f9bd8-1754-832e-a2f2-10e697b65849', hasData: false, opacity: '0.6' }],
            },
        ];

        const report = generateMinimalDebugReport(logs);

        expect(report).toContain('## Diagnostics');
        expect(report).toContain('Content script running for ChatGPT');
        expect(report).toContain('Save/Copy buttons injected');
        expect(report).toContain('Button state');
    });

    it('should support legacy [interceptor] prefix', () => {
        const logs: LogEntry[] = [
            {
                timestamp: '',
                level: 'info',
                message: '[interceptor] trigger ChatGPT 696bc3d5-fa84-8328-b209-4d65cb229e59',
                context: 'content',
            },
            {
                timestamp: '',
                level: 'info',
                message: '[interceptor] fetch 200 696bc3d5-fa84-8328-b209-4d65cb229e59',
                context: 'content',
            },
        ];

        const report = generateMinimalDebugReport(logs);

        expect(report).toContain('trigger ChatGPT');
        expect(report).toContain('fetch 200');
        expect(report).not.toContain('[interceptor]');
    });

    it('should filter noise lines', () => {
        const logs: LogEntry[] = [
            { timestamp: '', level: 'info', message: '[i] Fetch intercepted: https://example.com', context: 'content' },
            {
                timestamp: '',
                level: 'info',
                message: '[i] API adapter: none, Completion adapter: none',
                context: 'content',
            },
            {
                timestamp: '',
                level: 'debug',
                message:
                    '[NavigationManager] URL change detected: https://chatgpt.com/c/696bc3d5-fa84-8328-b209-4d65cb229e59',
                context: 'content',
            },
            {
                timestamp: '',
                level: 'info',
                message: '[i] trigger ChatGPT 696bc3d5-fa84-8328-b209-4d65cb229e59',
                context: 'content',
            },
        ];

        const report = generateMinimalDebugReport(logs);

        expect(report).not.toContain('Fetch intercepted');
        expect(report).not.toContain('API adapter');
        expect(report).not.toContain('[NavigationManager] URL change detected');
        expect(report).toContain('trigger ChatGPT');
    });

    it('should include critical success/failure messages', () => {
        const logs: LogEntry[] = [
            {
                timestamp: '2026-01-01T00:00:00.000Z',
                level: 'info',
                context: 'content',
                message: '[i] API match ChatGPT',
                data: [],
            },
            {
                timestamp: '2026-01-01T00:00:01.000Z',
                level: 'info',
                context: 'content',
                message: 'Successfully captured/cached data for conversation: 698ec52b-35ac-8329-84c2-e0abfcb8e66d',
                data: [],
            },
            {
                timestamp: '2026-01-01T00:00:02.000Z',
                level: 'info',
                context: 'content',
                message: '[i] DEBUG fetch response',
                data: [{ ok: false, status: 404 }],
            },
        ];

        const report = generateMinimalDebugReport(logs);

        // Should include success message even without [i] prefix
        expect(report).toContain('Successfully captured/cached data');
        expect(report).toContain('698ec52b');

        // Should include fetch response with status
        expect(report).toContain('fetch response');
        expect(report).toContain('404');
    });

    it('should retain calibration lines across deduped Grok sessions and derive convId from data', () => {
        const logs: LogEntry[] = [
            {
                timestamp: '',
                level: 'info',
                context: 'content',
                message: '[i] API match Grok',
                data: [],
            },
            {
                timestamp: '',
                level: 'info',
                context: 'content',
                message: '[i] API match Grok',
                data: [],
            },
            {
                timestamp: '',
                level: 'info',
                context: 'content',
                message: 'Calibration capture started',
                data: [{ conversationId: 'ef4a3424-9966-4dd3-8345-190f1f645ec2', platform: 'Grok' }],
            },
            {
                timestamp: '',
                level: 'warn',
                context: 'content',
                message: 'Calibration capture failed after retries',
                data: [{ conversationId: 'ef4a3424-9966-4dd3-8345-190f1f645ec2' }],
            },
        ];

        const report = generateMinimalDebugReport(logs);

        expect(report).toContain('Sessions: 2');
        expect(report).toContain('Grok ef4a3424');
        expect(report).toContain('Calibration capture started');
        expect(report).toContain('Calibration capture failed after retries');
    });
});
