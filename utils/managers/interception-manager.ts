/**
 * Interception Manager
 *
 * Handles listening for intercepted data messages from the content script interceptor.
 * Parses raw data using the appropriate platform adapter.
 * Manages the LRU cache of validation conversation data.
 */

import type { LLMPlatform } from '@/platforms/types';
import { isConversationReady } from '@/utils/conversation-readiness';
import { logger } from '@/utils/logger';
import { LRUCache } from '@/utils/lru-cache';
import type { ConversationData } from '@/utils/types';

export class InterceptionManager {
    private readonly conversationCache: LRUCache<string, ConversationData>;
    private currentAdapter: LLMPlatform | null = null;
    private readonly windowRef: Window;
    private readonly globalRef: typeof globalThis;

    // Callback to notify the runner (and UI) that new valid data has been intercepted/cached
    private onDataCaptured: (
        conversationId: string,
        data: ConversationData,
        meta?: { attemptId?: string; source?: string },
    ) => void;

    constructor(
        onDataCaptured: (
            conversationId: string,
            data: ConversationData,
            meta?: { attemptId?: string; source?: string },
        ) => void,
        options: { window?: Window; global?: typeof globalThis } = {},
    ) {
        this.conversationCache = new LRUCache<string, ConversationData>(10);
        this.onDataCaptured = onDataCaptured;
        this.windowRef = options.window ?? window;
        this.globalRef = options.global ?? globalThis;
    }

    public updateAdapter(adapter: LLMPlatform | null) {
        this.currentAdapter = adapter;
    }

    public start(): void {
        this.windowRef.addEventListener('message', this.handleMessage);
        this.processQueuedMessages();
        this.processQueuedLogMessages();
        // In case queued messages are added before the listener is attached
        setTimeout(() => {
            this.processQueuedMessages();
            this.processQueuedLogMessages();
        }, 0);
        // #region agent log — diagnostic: confirm message listener is attached
        logger.info('[InterceptionManager] Message listener attached', {
            platform: this.currentAdapter?.name ?? 'none',
        });
        // #endregion
    }

    public flushQueuedMessages(): void {
        this.processQueuedMessages();
    }

    public stop(): void {
        this.windowRef.removeEventListener('message', this.handleMessage);
    }

    public getConversation(id: string): ConversationData | undefined {
        return this.conversationCache.get(id);
    }

    public ingestInterceptedData(message: { type?: string; url: string; data: string; platform?: string }): void {
        this.handleInterceptedData({
            type: 'LLM_CAPTURE_DATA_INTERCEPTED',
            ...message,
        });
    }

    public ingestConversationData(data: ConversationData, source = 'snapshot'): void {
        if (!this.isValidConversationData(data)) {
            logger.warn('Ignoring invalid ConversationData payload', { source });
            return;
        }

        const conversationId = data.conversation_id;
        const existing = this.conversationCache.get(conversationId);
        const isSnapshotSource = source.includes('snapshot') || source.includes('dom');
        if (existing && isSnapshotSource) {
            const existingReady = this.isConversationReady(existing);
            const incomingReady = this.isConversationReady(data);
            if (existingReady && !incomingReady) {
                logger.info('Ignoring degraded snapshot overwrite for ready conversation', {
                    conversationId,
                    source,
                });
                this.onDataCaptured(conversationId, existing, { source: 'canonical-preserved' });
                return;
            }
        }
        this.conversationCache.set(conversationId, data);
        logger.info(`Successfully captured/cached data for conversation: ${conversationId}`, {
            source,
            directIngest: true,
        });
        this.onDataCaptured(conversationId, data, { source });
    }

    private isConversationReady(data: ConversationData): boolean {
        if (this.currentAdapter?.evaluateReadiness) {
            return this.currentAdapter.evaluateReadiness(data).ready;
        }
        return isConversationReady(data);
    }

    private handleMessage = (event: MessageEvent): void => {
        if (event.source !== this.windowRef) {
            return;
        }

        if (event.origin !== this.windowRef.location.origin) {
            return;
        }

        const message = event.data;

        // Handle logs
        if (message?.type === 'LLM_LOG_ENTRY') {
            this.handleLogEntry(message.payload);
            return;
        }

        // Handle intercepted data
        if (message?.type === 'LLM_CAPTURE_DATA_INTERCEPTED' && message.data) {
            this.handleInterceptedData(message);
        }
    };

    private handleLogEntry(payload: any): void {
        if (!payload || typeof payload.message !== 'string') {
            logger.warn('Malformed LLM_LOG_ENTRY payload', payload);
            return;
        }

        const { level, message: logMessage, data, context } = payload;

        // Normalize data to array
        const extra = Array.isArray(data) ? data : data !== undefined ? [data] : [];
        const ctx = context === 'interceptor' ? 'i' : (context ?? '?');
        const prefixedMsg = `[${ctx}] ${logMessage}`;

        if (level === 'error') {
            logger.error(prefixedMsg, ...extra);
        } else if (level === 'warn') {
            logger.warn(prefixedMsg, ...extra);
        } else if (level === 'debug') {
            logger.debug(prefixedMsg, ...extra);
        } else {
            logger.info(prefixedMsg, ...extra);
        }
    }

    private handleInterceptedData(message: any): void {
        logger.info('Intercepted payload received', {
            platform: this.currentAdapter?.name ?? 'unknown',
            size: typeof message.data === 'string' ? message.data.length : 0,
        });

        if (!this.currentAdapter) {
            logger.warn('No currentAdapter in manager, ignoring message');
            return;
        }

        try {
            const data = this.currentAdapter.parseInterceptedData(message.data, message.url);

            if (data?.conversation_id) {
                const conversationId = data.conversation_id;
                this.conversationCache.set(conversationId, data);

                logger.info(`Successfully captured/cached data for conversation: ${conversationId}`);

                // Notify runner to update UI if this matches current view
                this.onDataCaptured(conversationId, data, {
                    source: 'network',
                    attemptId: typeof message?.attemptId === 'string' ? message.attemptId : undefined,
                });
            } else {
                const level = this.getParseMissLevel(message.url);
                const payload = {
                    adapter: this.currentAdapter.name,
                    url: message.url,
                    parsedTitle: data?.title ?? null,
                };

                if (level === 'info') {
                    logger.info('Metadata-only response (no messages yet)', payload);
                } else {
                    logger.warn('Failed to parse conversation ID from intercepted data', payload);
                }
            }
        } catch (error) {
            logger.error('Error parsing intercepted data:', error);
        }
    }

    private isValidConversationData(data: ConversationData): boolean {
        return (
            !!data &&
            typeof data === 'object' &&
            typeof data.conversation_id === 'string' &&
            data.conversation_id.length > 0 &&
            !!data.mapping &&
            typeof data.mapping === 'object'
        );
    }

    private getParseMissLevel(url: unknown): 'info' | 'warn' {
        if (typeof url !== 'string') {
            return 'warn';
        }

        const isExpectedAuxMiss =
            url.includes('/rest/app-chat/conversations_v2/') ||
            url.includes('/rest/app-chat/conversations/new') ||
            (url.includes('/rest/app-chat/conversations/') && url.includes('/response-node'));

        return isExpectedAuxMiss ? 'info' : 'warn';
    }

    private processQueuedMessages(): void {
        const globalQueue = (this.globalRef as any).__BLACKIYA_CAPTURE_QUEUE__;
        const windowQueue = (this.windowRef as any).__BLACKIYA_CAPTURE_QUEUE__;
        const queue = Array.isArray(globalQueue) ? globalQueue : windowQueue;
        if (!Array.isArray(queue) || queue.length === 0) {
            return;
        }

        for (const message of queue) {
            if (message?.type === 'LLM_CAPTURE_DATA_INTERCEPTED' && message.data) {
                this.handleInterceptedData(message);
            }
        }

        (this.globalRef as any).__BLACKIYA_CAPTURE_QUEUE__ = [];
        (this.windowRef as any).__BLACKIYA_CAPTURE_QUEUE__ = [];
    }

    private processQueuedLogMessages(): void {
        const globalQueue = (this.globalRef as any).__BLACKIYA_LOG_QUEUE__;
        const windowQueue = (this.windowRef as any).__BLACKIYA_LOG_QUEUE__;
        const queue = Array.isArray(globalQueue) ? globalQueue : windowQueue;
        if (!Array.isArray(queue) || queue.length === 0) {
            return;
        }

        for (const message of queue) {
            if (message?.type === 'LLM_LOG_ENTRY') {
                this.handleLogEntry(message.payload);
            }
        }

        (this.globalRef as any).__BLACKIYA_LOG_QUEUE__ = [];
        (this.windowRef as any).__BLACKIYA_LOG_QUEUE__ = [];
    }
}
