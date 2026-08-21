import { describe, expect, it } from 'bun:test';
import { BULK_EXPORT_PROGRESS_MESSAGE } from './contract';
import { createProgressReporter } from './progress';

describe('bulk export progress reporter', () => {
    it('should emit the established started, progress, and completed messages', () => {
        const messages: unknown[] = [];
        const progress = createProgressReporter('ChatGPT', (message) => {
            messages.push(message);
        });

        progress.started(2);
        progress.progress({ discovered: 2, attempted: 1, exported: 1, failed: 0 });
        progress.completed({ discovered: 2, attempted: 2, exported: 2, failed: 0 });

        expect(messages).toEqual([
            {
                type: BULK_EXPORT_PROGRESS_MESSAGE,
                stage: 'started',
                platform: 'ChatGPT',
                discovered: 2,
                attempted: 0,
                exported: 0,
                failed: 0,
                remaining: 2,
            },
            {
                type: BULK_EXPORT_PROGRESS_MESSAGE,
                stage: 'progress',
                platform: 'ChatGPT',
                discovered: 2,
                attempted: 1,
                exported: 1,
                failed: 0,
                remaining: 1,
            },
            {
                type: BULK_EXPORT_PROGRESS_MESSAGE,
                stage: 'completed',
                platform: 'ChatGPT',
                discovered: 2,
                attempted: 2,
                exported: 2,
                failed: 0,
                remaining: 0,
            },
        ]);
    });

    it('should report failed progress with a bounded remaining count', () => {
        const messages: unknown[] = [];
        const progress = createProgressReporter('Grok', (message) => {
            messages.push(message);
        });

        progress.progress({ discovered: 1, attempted: 1, exported: 0, failed: 1 });

        expect(messages[0]).toEqual({
            type: BULK_EXPORT_PROGRESS_MESSAGE,
            stage: 'progress',
            platform: 'Grok',
            discovered: 1,
            attempted: 1,
            exported: 0,
            failed: 1,
            remaining: 0,
        });
    });
});
