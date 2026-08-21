import { describe, expect, it } from 'bun:test';
import {
    isLocalRelayUrl,
    parseRelayNdjson,
    sanitizeRelayEvent,
} from './relay';

describe('development relay contract', () => {
    it('should accept localhost relay endpoints and reject remote endpoints', () => {
        expect(isLocalRelayUrl('http://127.0.0.1:4177/events')).toBe(true);
        expect(isLocalRelayUrl('http://localhost:4177/events')).toBe(true);
        expect(isLocalRelayUrl('https://example.test/events')).toBe(false);
        expect(isLocalRelayUrl('http://127.0.0.2:4177/events')).toBe(false);
    });

    it('should strip query strings and drop credential-shaped fields', () => {
        const sanitized = sanitizeRelayEvent({
            kind: 'stream-start',
            platform: 'ChatGPT',
            url: 'https://chatgpt.com/backend-api/f/conversation?access_token=secret#fragment',
            headers: { authorization: 'Bearer secret' },
            body: 'credential-bearing request body',
            method: 'post',
        });

        expect(sanitized).toMatchObject({
            schemaVersion: 1,
            source: 'blackiya-dev-relay',
            kind: 'stream-start',
            platform: 'ChatGPT',
            path: '/backend-api/f/conversation',
            method: 'POST',
        });
        expect(sanitized && 'headers' in sanitized).toBe(false);
        expect(sanitized && 'body' in sanitized).toBe(false);
        expect(JSON.stringify(sanitized)).not.toContain('secret');
    });

    it('should retain only bounded stream and Save JSON diagnostics', () => {
        const event = sanitizeRelayEvent({
            kind: 'stream-frame',
            streamId: 'relay:1',
            path: '/backend-api/f/conversation?foo=bar',
            sequence: 4,
            frameKind: 'refusal',
            event: 'refusal',
            bytes: 120,
            text: 'private response text',
        });
        const saveState = sanitizeRelayEvent({
            kind: 'save-state',
            state: 'success',
            disabled: false,
        });
        const saveError = sanitizeRelayEvent({
            kind: 'save-state',
            state: 'error',
            errorKind: 'not_terminal',
        });

        expect(event).toMatchObject({
            kind: 'stream-frame',
            streamId: 'relay:1',
            path: '/backend-api/f/conversation',
            sequence: 4,
            frameKind: 'refusal',
            event: 'refusal',
            bytes: 120,
        });
        expect(saveState).toMatchObject({ kind: 'save-state', state: 'success', disabled: false });
        expect(saveError).toMatchObject({ kind: 'save-state', state: 'error', errorKind: 'not_terminal' });
        expect(JSON.stringify(event)).not.toContain('private response text');
    });

    it('should parse newline-delimited events and reject malformed or unsupported lines', () => {
        const parsed = parseRelayNdjson(
            `${JSON.stringify({ kind: 'save-click' })}\nnot-json\n${JSON.stringify({ kind: 'unknown' })}\n`,
        );

        expect(parsed).toHaveLength(1);
        expect(parsed[0]?.kind).toBe('save-click');
    });
});
