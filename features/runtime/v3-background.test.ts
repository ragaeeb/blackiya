import { describe, expect, it, mock } from 'bun:test';
import { createV3BackgroundMessageHandler } from '@/features/runtime/v3-background';

const createActionApi = () => ({
    setBadgeText: mock(async () => undefined),
    setBadgeBackgroundColor: mock(async () => undefined),
    setTitle: mock(async () => undefined),
});

describe('v3 background progress handler', () => {
    it('should update the action while bulk export is progressing', () => {
        const actionApi = createActionApi();
        const handleMessage = createV3BackgroundMessageHandler(actionApi);

        expect(
            handleMessage(
                {
                    type: 'BLACKIYA_BULK_EXPORT_PROGRESS',
                    stage: 'progress',
                    platform: 'ChatGPT',
                    attempted: 2,
                    discovered: 5,
                    remaining: 3,
                },
                { tab: { id: 7 } },
            ),
        ).toBe(true);

        expect(actionApi.setBadgeText).toHaveBeenCalledWith({ text: '3', tabId: 7 });
        expect(actionApi.setTitle).toHaveBeenCalledWith({
            title: 'Blackiya: Exporting ChatGPT (2/5)',
            tabId: 7,
        });
    });

    it('should clear the badge after completion and mark failures', () => {
        const actionApi = createActionApi();
        const handleMessage = createV3BackgroundMessageHandler(actionApi);

        expect(
            handleMessage(
                {
                    type: 'BLACKIYA_BULK_EXPORT_PROGRESS',
                    stage: 'completed',
                    exported: 4,
                    attempted: 5,
                },
                { tab: { id: 8 } },
            ),
        ).toBe(true);
        expect(actionApi.setBadgeText).toHaveBeenCalledWith({ text: '', tabId: 8 });

        expect(
            handleMessage(
                {
                    type: 'BLACKIYA_BULK_EXPORT_PROGRESS',
                    stage: 'failed',
                    message: 'Auth expired',
                },
                { tab: { id: 8 } },
            ),
        ).toBe(true);
        expect(actionApi.setBadgeText).toHaveBeenCalledWith({ text: '!', tabId: 8 });
        expect(actionApi.setTitle).toHaveBeenCalledWith({
            title: 'Blackiya: Export failed - Auth expired',
            tabId: 8,
        });
    });

    it('should ignore non-bulk messages and send no action calls without a tab ID', () => {
        const actionApi = createActionApi();
        const handleMessage = createV3BackgroundMessageHandler(actionApi);

        expect(handleMessage({ type: 'BLACKIYA_RESPONSE_LIFECYCLE' }, { tab: { id: 1 } })).toBe(false);
        expect(
            handleMessage(
                {
                    type: 'BLACKIYA_BULK_EXPORT_PROGRESS',
                    stage: 'progress',
                    remaining: 1,
                },
                { tab: {} },
            ),
        ).toBe(true);
        expect(actionApi.setBadgeText).not.toHaveBeenCalled();
    });
});
