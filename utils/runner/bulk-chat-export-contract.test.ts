import { describe, expect, it } from 'bun:test';

import {
    BULK_EXPORT_CHATS_MESSAGE,
    BULK_EXPORT_PROGRESS_MESSAGE,
    isBulkExportChatsMessage,
    isBulkExportProgressMessage,
} from '@/utils/runner/bulk-chat-export-contract';

describe('bulk-chat-export-contract', () => {
    it('should accept valid bulk export message payloads', () => {
        expect(
            isBulkExportChatsMessage({
                type: BULK_EXPORT_CHATS_MESSAGE,
                limit: 0,
                delayMs: 1200,
                timeoutMs: 20000,
            }),
        ).toBeTrue();
        expect(isBulkExportChatsMessage({ type: BULK_EXPORT_CHATS_MESSAGE })).toBeTrue();
    });

    it('should reject invalid message payloads', () => {
        expect(isBulkExportChatsMessage(null)).toBeFalse();
        expect(isBulkExportChatsMessage({ type: 'OTHER' })).toBeFalse();
        expect(isBulkExportChatsMessage({ type: BULK_EXPORT_CHATS_MESSAGE, limit: Number.NaN })).toBeFalse();
        expect(
            isBulkExportChatsMessage({ type: BULK_EXPORT_CHATS_MESSAGE, delayMs: Number.POSITIVE_INFINITY }),
        ).toBeFalse();
    });

    it('should validate bulk export progress payloads', () => {
        expect(
            isBulkExportProgressMessage({
                type: BULK_EXPORT_PROGRESS_MESSAGE,
                stage: 'progress',
                platform: 'ChatGPT',
                discovered: 10,
                attempted: 2,
                exported: 1,
                failed: 1,
                remaining: 8,
            }),
        ).toBeTrue();
        expect(
            isBulkExportProgressMessage({
                type: BULK_EXPORT_PROGRESS_MESSAGE,
                stage: 'failed',
                message: 'network failed',
            }),
        ).toBeTrue();
        expect(isBulkExportProgressMessage({ type: BULK_EXPORT_PROGRESS_MESSAGE, stage: 'oops' })).toBeFalse();
    });
});
