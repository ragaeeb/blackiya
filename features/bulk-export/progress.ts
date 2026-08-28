import { BULK_EXPORT_PROGRESS_MESSAGE, type BulkExportProgressMessage } from './contract';

export type ProgressCounts = {
    discovered: number;
    attempted: number;
    exported: number;
    failed: number;
};

export type ProgressReporter = {
    started: (discovered: number) => void;
    progress: (counts: ProgressCounts) => void;
    completed: (counts: ProgressCounts) => void;
    failed: (counts: ProgressCounts, message: string) => void;
};

const MAX_PROGRESS_ERROR_LENGTH = 240;

export const sanitizeProgressError = (message: string): string => {
    const withoutQuery = message.replace(/https?:\/\/[^\s"'<>]+/gi, (value) => {
        try {
            const url = new URL(value);
            return `${url.origin}${url.pathname}`;
        } catch {
            return '[redacted-url]';
        }
    });
    return withoutQuery.length > MAX_PROGRESS_ERROR_LENGTH
        ? `${withoutQuery.slice(0, MAX_PROGRESS_ERROR_LENGTH - 3)}...`
        : withoutQuery;
};

export const createProgressReporter = (
    platform: string,
    onProgress: ((message: BulkExportProgressMessage) => void) | undefined,
): ProgressReporter => {
    const emit = onProgress ?? (() => {});

    return {
        started: (discovered) => {
            emit({
                type: BULK_EXPORT_PROGRESS_MESSAGE,
                stage: 'started',
                platform,
                discovered,
                attempted: 0,
                exported: 0,
                failed: 0,
                remaining: discovered,
            });
        },
        progress: (counts) => {
            emit({
                type: BULK_EXPORT_PROGRESS_MESSAGE,
                stage: 'progress',
                platform,
                ...counts,
                remaining: Math.max(0, counts.discovered - counts.attempted),
            });
        },
        completed: (counts) => {
            emit({
                type: BULK_EXPORT_PROGRESS_MESSAGE,
                stage: 'completed',
                platform,
                ...counts,
                remaining: 0,
            });
        },
        failed: (counts, message) => {
            emit({
                type: BULK_EXPORT_PROGRESS_MESSAGE,
                stage: 'failed',
                platform,
                ...counts,
                remaining: Math.max(0, counts.discovered - counts.attempted),
                message: sanitizeProgressError(message),
            });
        },
    };
};
