import type { BulkExportProgressMessage } from '@/features/bulk-export/contract';
import { runBulkExport } from '@/features/bulk-export/orchestrator';
import { sanitizeProgressError } from '@/features/bulk-export/progress';
import type { MainWorldSingleExportTarget } from '@/features/runtime/main-world-command-contract';
import {
    type MainWorldCommandOperations,
    setupMainWorldCommandHandler,
} from '@/features/runtime/main-world-command-handler';
import { conversationResponseCache } from '@/features/single-export/conversation-response-cache';
import { performSingleExport } from '@/features/single-export/single-export-service';
import { streamDebugRecorder } from '@/features/stream-debug/recorder';
import { getPlatformAdapter } from '@/platforms/factory';
import { extractMetaNextFlightConversation } from '@/platforms/meta/next-flight';
import { metaGraphqlResponseAssembler } from '@/platforms/meta/response-assembler';
import { downloadStringAsJsonFile } from '@/utils/dom-download';
import { downloadAsJSON } from '@/utils/download';
import { platformHeaderStore } from '@/utils/platform-header-store';
import { MESSAGE_TYPES } from '@/utils/protocol/constants';
import { getSessionToken, setSessionToken } from '@/utils/protocol/session-token';
import { getGeminiBatchexecuteContext, resetGeminiBatchexecuteContext } from './gemini-batchexecute-context-store';

const MAIN_BRIDGE_INSTALLED_KEY = '__BLACKIYA_MAIN_BRIDGE_INSTALLED__';

export const shouldApplySessionInitToken = (existingToken: string | undefined, incomingToken: string): boolean => {
    return typeof incomingToken === 'string' && incomingToken.length > 0 && !existingToken;
};

type SessionInitMessage = {
    type: typeof MESSAGE_TYPES.SESSION_INIT;
    token: string;
};

type WindowOriginTarget = { location: { origin: string } };

export const isSameWindowOriginEvent = (
    event: Pick<MessageEvent, 'origin' | 'source'>,
    targetWindow: WindowOriginTarget,
): boolean => event.source === targetWindow && event.origin === targetWindow.location.origin;

export const setupMainWorldBridge = () => {
    if ((window as any)[MAIN_BRIDGE_INSTALLED_KEY] === true) {
        return;
    }
    (window as any)[MAIN_BRIDGE_INSTALLED_KEY] = true;

    const handleSessionInit = (message: SessionInitMessage) => {
        if (shouldApplySessionInitToken(getSessionToken(), message.token)) {
            setSessionToken(message.token);
        }
    };

    const invalidateAuthContext = (platformName: string) => {
        platformHeaderStore.clear(platformName);
        if (platformName === 'Gemini') {
            resetGeminiBatchexecuteContext();
        }
    };

    const resolveAdapter = () => getPlatformAdapter(window.location.href);

    const runSingleExportInMainWorld = async (target: MainWorldSingleExportTarget) => {
        const pageUrl = window.location.href;
        const adapter = getPlatformAdapter(pageUrl);
        const conversationId = adapter?.extractConversationId(pageUrl);
        if (!adapter || adapter.name !== target.platform || conversationId !== target.conversationId) {
            const error = new Error('Conversation changed before export started.') as Error & { kind?: string };
            error.kind = 'conversation_changed';
            throw error;
        }

        if (adapter.name === 'Meta Muse' && !conversationResponseCache.get(adapter.name, conversationId)) {
            const embedded = extractMetaNextFlightConversation(
                document.querySelectorAll('script'),
                conversationId,
                conversationResponseCache.getMaxBytesPerEntry(),
            );
            if (embedded) {
                const data = metaGraphqlResponseAssembler.ingestInitialDocument(
                    embedded.conversationId,
                    embedded.responseText,
                );
                if (data) {
                    conversationResponseCache.set(adapter.name, data);
                }
            }
        }

        const result = await performSingleExport(undefined, {
            resolveAdapter: () => adapter,
            getPageUrl: () => pageUrl,
            getAuthHeaders: () => platformHeaderStore.get(adapter.name),
            getGeminiBatchexecuteContext,
            getCachedConversation: (platformName, conversationId) =>
                conversationResponseCache.get(platformName, conversationId),
            invalidateAuthContext,
            downloadJson: downloadStringAsJsonFile,
        });
        if (result.kind === 'failure') {
            const error = new Error(formatSingleExportError(result.error)) as Error & { kind?: string };
            error.kind = result.error.kind;
            throw error;
        }
        return {
            operation: 'single_export' as const,
            platform: result.platformName,
            filename: result.filename,
        };
    };

    const runBulkExportInMainWorld = (
        options: { limit: number; delayMs: number; timeoutMs: number },
        onProgress: (message: BulkExportProgressMessage) => void,
    ) =>
        runBulkExport(options, {
            getAdapter: resolveAdapter,
            getAuthHeaders: () => {
                const adapter = resolveAdapter();
                return adapter ? platformHeaderStore.get(adapter.name) : undefined;
            },
            getGeminiBatchexecuteContext,
            invalidateAuthContext,
            onProgress,
        }).then((result) => ({
            operation: 'bulk_export' as const,
            ...result,
            warnings: result.warnings.map(sanitizeProgressError),
        }));

    const exportStreamDebugInMainWorld = async () => {
        const records = streamDebugRecorder.exportRecords();
        const filename = `blackiya-stream-debug-${new Date().toISOString().replace(/[:.]/g, '-')}`;
        if (!downloadAsJSON(records, filename)) {
            throw new Error('Could not download stream debug JSON.');
        }
        return {
            operation: 'stream_debug_export' as const,
            streamCount: records.length,
            frameCount: records.reduce((total, record) => total + record.frames.length, 0),
            filename: `${filename}.json`,
        };
    };

    const operations: MainWorldCommandOperations = {
        singleExport: runSingleExportInMainWorld,
        bulkExport: runBulkExportInMainWorld,
        exportStreamDebug: exportStreamDebugInMainWorld,
        clearStreamDebug: async () => {
            const clearedStreams = streamDebugRecorder.exportRecords().length;
            streamDebugRecorder.clear();
            return { operation: 'stream_debug_clear' as const, clearedStreams };
        },
    };

    setupMainWorldCommandHandler({ window: window as any, operations });

    window.addEventListener('message', (event: MessageEvent) => {
        if (!isSameWindowOriginEvent(event, window) || !event.data || typeof event.data !== 'object') {
            return;
        }
        const message = event.data as Partial<SessionInitMessage>;
        if (message.type === MESSAGE_TYPES.SESSION_INIT && typeof message.token === 'string') {
            handleSessionInit(message as SessionInitMessage);
        }
    });
};

const formatSingleExportError = (error: {
    kind: string;
    reason?: string;
    status?: number;
    timeoutMs?: number;
}): string => {
    switch (error.kind) {
        case 'not_terminal':
            return `Conversation is not ready to save${error.reason ? ` (${error.reason})` : ''}.`;
        case 'timeout':
            return `Conversation request timed out after ${error.timeoutMs ?? 'the configured'} ms.`;
        case 'missing_auth':
            return 'The page did not provide the authentication context needed to save this conversation.';
        case 'http_failure':
            return `Conversation request failed${error.status ? ` (${error.status})` : ''}.`;
        case 'download_failure':
            return error.reason
                ? `Could not download the conversation (${error.reason}).`
                : 'Could not download the conversation.';
        default:
            return error.reason ? `${error.kind}: ${error.reason}` : error.kind;
    }
};
