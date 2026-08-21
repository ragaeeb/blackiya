import { describe, expect, it } from 'bun:test';
import { DEFAULT_BULK_EXPORT_DELAY_MS, DEFAULT_BULK_EXPORT_TIMEOUT_MS } from '@/utils/settings';
import {
    createClearStreamDebugMessage,
    createExportChatsMessage,
    createExportStreamDebugMessage,
    formatBulkExportStatus,
    formatStreamDebugClearedStatus,
    formatStreamDebugExportedStatus,
    isV3ErrorResponse,
    isV3SuccessResponse,
    V3_CLEAR_STREAM_DEBUG_MESSAGE,
    V3_EXPORT_CHATS_MESSAGE,
    V3_EXPORT_STREAM_DEBUG_MESSAGE,
} from './v3-messaging';

describe('popup v3 messaging', () => {
    it('should build the v3 bulk export message with normalized options', () => {
        expect(createExportChatsMessage('5')).toEqual({
            type: V3_EXPORT_CHATS_MESSAGE,
            limit: 5,
            delayMs: DEFAULT_BULK_EXPORT_DELAY_MS,
            timeoutMs: DEFAULT_BULK_EXPORT_TIMEOUT_MS,
        });
        expect(createExportChatsMessage('')).toEqual({
            type: V3_EXPORT_CHATS_MESSAGE,
            limit: 0,
            delayMs: DEFAULT_BULK_EXPORT_DELAY_MS,
            timeoutMs: DEFAULT_BULK_EXPORT_TIMEOUT_MS,
        });
        expect(createExportChatsMessage('not-a-number').limit).toBe(0);
    });

    it('should use the parent v3 message type strings', () => {
        expect(V3_EXPORT_CHATS_MESSAGE).toBe('BLACKIYA_V3_EXPORT_CHATS');
        expect(V3_EXPORT_STREAM_DEBUG_MESSAGE).toBe('BLACKIYA_V3_EXPORT_STREAM_DEBUG');
        expect(V3_CLEAR_STREAM_DEBUG_MESSAGE).toBe('BLACKIYA_V3_CLEAR_STREAM_DEBUG');
    });

    it('should build stream debug messages without extra payload', () => {
        expect(createExportStreamDebugMessage()).toEqual({ type: V3_EXPORT_STREAM_DEBUG_MESSAGE });
        expect(createClearStreamDebugMessage()).toEqual({ type: V3_CLEAR_STREAM_DEBUG_MESSAGE });
    });

    it('should guard v3 success and error responses', () => {
        expect(isV3SuccessResponse({ ok: true })).toBe(true);
        expect(isV3SuccessResponse({ ok: true, result: { exported: 2 } })).toBe(true);
        expect(isV3SuccessResponse({ ok: false, error: 'x' })).toBe(false);
        expect(isV3SuccessResponse(null)).toBe(false);
        expect(isV3SuccessResponse({ ok: 'yes' })).toBe(false);

        expect(isV3ErrorResponse({ ok: false, error: 'boom' })).toBe(true);
        expect(isV3ErrorResponse({ ok: false })).toBe(false);
        expect(isV3ErrorResponse({ ok: false, error: 42 })).toBe(false);
        expect(isV3ErrorResponse({ ok: true })).toBe(false);
    });

    it('should format bulk export status concisely', () => {
        expect(formatBulkExportStatus({ platform: 'chatgpt', attempted: 4, exported: 4, warnings: [] })).toBe(
            'Exported 4/4 chats on chatgpt.',
        );

        expect(
            formatBulkExportStatus({
                platform: 'gemini',
                attempted: 3,
                exported: 2,
                warnings: ['1 failed'],
            }),
        ).toBe('Exported 2/3 chats on gemini. Warnings: 1 failed');

        expect(formatBulkExportStatus(undefined)).toBe('Export completed.');
        expect(formatBulkExportStatus('junk')).toBe('Export completed.');
    });

    it('should format stream debug statuses concisely', () => {
        expect(formatStreamDebugExportedStatus()).toBe('Stream debug exported.');
        expect(formatStreamDebugClearedStatus()).toBe('Stream debug cleared.');
    });
});
