import { describe, expect, it } from 'bun:test';
import {
    BULK_EXPORT_CHATS_MESSAGE,
    BULK_EXPORT_PROGRESS_MESSAGE,
    isBulkExportChatsMessage,
    isBulkExportProgressMessage,
} from './contract';

describe('contract validators', () => {
    describe('isBulkExportChatsMessage', () => {
        it('should accept valid message with all fields', () => {
            expect(
                isBulkExportChatsMessage({
                    type: BULK_EXPORT_CHATS_MESSAGE,
                    limit: 50,
                    delayMs: 1000,
                    timeoutMs: 15000,
                }),
            ).toBe(true);
        });

        it('should require the v3 bulk export options owned by the runtime contract', () => {
            expect(
                isBulkExportChatsMessage({
                    type: BULK_EXPORT_CHATS_MESSAGE,
                    limit: 0,
                    delayMs: 1200,
                    timeoutMs: 20000,
                }),
            ).toBe(true);
            expect(isBulkExportChatsMessage({ type: BULK_EXPORT_CHATS_MESSAGE })).toBe(false);
        });

        it('should reject message with invalid type', () => {
            expect(
                isBulkExportChatsMessage({
                    type: 'INVALID_TYPE',
                    limit: 50,
                }),
            ).toBe(false);
        });

        it('should reject message with non-finite limit', () => {
            expect(
                isBulkExportChatsMessage({
                    type: BULK_EXPORT_CHATS_MESSAGE,
                    limit: Number.NaN,
                }),
            ).toBe(false);
        });

        it('should reject message with infinite delayMs', () => {
            expect(
                isBulkExportChatsMessage({
                    type: BULK_EXPORT_CHATS_MESSAGE,
                    delayMs: Number.POSITIVE_INFINITY,
                }),
            ).toBe(false);
        });

        it('should reject non-object values', () => {
            expect(isBulkExportChatsMessage(null)).toBe(false);
            expect(isBulkExportChatsMessage(undefined)).toBe(false);
            expect(isBulkExportChatsMessage('string')).toBe(false);
            expect(isBulkExportChatsMessage(42)).toBe(false);
        });
    });

    describe('isBulkExportProgressMessage', () => {
        it('should accept valid started stage message', () => {
            expect(
                isBulkExportProgressMessage({
                    type: BULK_EXPORT_PROGRESS_MESSAGE,
                    stage: 'started',
                    platform: 'ChatGPT',
                    discovered: 10,
                    attempted: 0,
                    exported: 0,
                    failed: 0,
                    remaining: 10,
                }),
            ).toBe(true);
        });

        it('should accept valid progress stage message', () => {
            expect(
                isBulkExportProgressMessage({
                    type: BULK_EXPORT_PROGRESS_MESSAGE,
                    stage: 'progress',
                    platform: 'Gemini',
                    discovered: 100,
                    attempted: 50,
                    exported: 48,
                    failed: 2,
                    remaining: 50,
                }),
            ).toBe(true);
        });

        it('should accept valid completed stage message', () => {
            expect(
                isBulkExportProgressMessage({
                    type: BULK_EXPORT_PROGRESS_MESSAGE,
                    stage: 'completed',
                    platform: 'Grok',
                    discovered: 25,
                    attempted: 25,
                    exported: 23,
                    failed: 2,
                    remaining: 0,
                }),
            ).toBe(true);
        });

        it('should accept valid failed stage message with error', () => {
            expect(
                isBulkExportProgressMessage({
                    type: BULK_EXPORT_PROGRESS_MESSAGE,
                    stage: 'failed',
                    message: 'Authentication failed',
                }),
            ).toBe(true);
        });

        it('should accept minimal valid message', () => {
            expect(
                isBulkExportProgressMessage({
                    type: BULK_EXPORT_PROGRESS_MESSAGE,
                    stage: 'started',
                }),
            ).toBe(true);
        });

        it('should reject message with invalid stage', () => {
            expect(
                isBulkExportProgressMessage({
                    type: BULK_EXPORT_PROGRESS_MESSAGE,
                    stage: 'invalid',
                }),
            ).toBe(false);
        });

        it('should reject message with non-finite discovered', () => {
            expect(
                isBulkExportProgressMessage({
                    type: BULK_EXPORT_PROGRESS_MESSAGE,
                    stage: 'progress',
                    discovered: Number.NaN,
                }),
            ).toBe(false);
        });

        it('should reject non-object values', () => {
            expect(isBulkExportProgressMessage(null)).toBe(false);
            expect(isBulkExportProgressMessage(undefined)).toBe(false);
            expect(isBulkExportProgressMessage([])).toBe(false);
        });
    });
});
