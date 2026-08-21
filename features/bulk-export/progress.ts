import {
    BULK_EXPORT_PROGRESS_MESSAGE,
    type BulkExportProgressMessage,
} from './contract';

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
    };
};
