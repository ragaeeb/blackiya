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
import { resolveTokenValidationFailureReason } from '@/utils/protocol/session-token';
import { isGenericConversationTitle } from '@/utils/title-resolver';
import type { ConversationData } from '@/utils/types';

export class InterceptionManager {
    private static readonly BLOCKED_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
    private readonly conversationCache: LRUCache<string, ConversationData>;
    private readonly specificTitleCache: LRUCache<string, string>;
    private currentAdapter: LLMPlatform | null = null;
    private readonly windowRef: Window;
    private readonly globalRef: typeof globalThis;
    private lastInvalidTokenLogAtMs = 0;

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
        this.specificTitleCache = new LRUCache<string, string>(50);
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
        const cached = this.conversationCache.get(id);
        if (!cached) {
            return undefined;
        }
        this.preserveSpecificTitle(id, cached, 'cache-read');
        return cached;
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
        this.preserveSpecificTitle(conversationId, data, source, existing);
        const target = existing && isSnapshotSource ? this.mergeSnapshotIntoExisting(existing, data) : data;
        this.conversationCache.set(conversationId, target);
        logger.info(`Successfully captured/cached data for conversation: ${conversationId}`, {
            source,
            directIngest: true,
        });
        this.onDataCaptured(conversationId, target, { source });
    }

    private mergeSnapshotIntoExisting(existing: ConversationData, incoming: ConversationData): ConversationData {
        // Preserve object identity so downstream references (e.g. late title updates) stay attached.
        for (const [key, value] of Object.entries(incoming as unknown as Record<string, unknown>)) {
            if (InterceptionManager.BLOCKED_KEYS.has(key)) {
                continue;
            }
            (existing as unknown as Record<string, unknown>)[key] = this.cloneSnapshotValue(value);
        }
        return existing;
    }

    private cloneSnapshotValue(value: unknown): unknown {
        if (Array.isArray(value)) {
            return value.map((item) => this.cloneSnapshotValue(item));
        }
        if (value && typeof value === 'object') {
            const source = value as Record<string, unknown>;
            const cloned: Record<string, unknown> = {};
            for (const [k, nested] of Object.entries(source)) {
                cloned[k] = this.cloneSnapshotValue(nested);
            }
            return cloned;
        }
        return value;
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

        const message = event.data as Record<string, unknown> | null;
        const messageType = typeof message?.type === 'string' ? message.type : '';

        if (messageType === 'LLM_LOG_ENTRY' || messageType === 'LLM_CAPTURE_DATA_INTERCEPTED') {
            const tokenFailureReason = resolveTokenValidationFailureReason(message);
            if (tokenFailureReason !== null) {
                const now = Date.now();
                if (now - this.lastInvalidTokenLogAtMs > 1500) {
                    this.lastInvalidTokenLogAtMs = now;
                    logger.debug('Dropped interceptor message due to token validation failure', {
                        reason: tokenFailureReason,
                        messageType,
                    });
                }
                return;
            }
        }

        // Handle logs
        if (messageType === 'LLM_LOG_ENTRY') {
            this.handleLogEntry((message as { payload?: unknown }).payload);
            return;
        }

        // Handle intercepted data
        if (messageType === 'LLM_CAPTURE_DATA_INTERCEPTED' && typeof message?.data === 'string') {
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
                const source = typeof message?.source === 'string' ? message.source : 'network';
                const existing = this.conversationCache.get(conversationId);
                this.preserveSpecificTitle(conversationId, data, source, existing);
                this.conversationCache.set(conversationId, data);

                logger.info(`Successfully captured/cached data for conversation: ${conversationId}`);

                // Notify runner to update UI if this matches current view
                this.onDataCaptured(conversationId, data, {
                    source,
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

    private rememberSpecificTitle(conversationId: string, title: string, source: string): void {
        const previousTitle = this.specificTitleCache.get(conversationId) ?? null;
        if (previousTitle === title) {
            return;
        }
        this.specificTitleCache.set(conversationId, title);
        logger.info('Updated remembered specific title', {
            conversationId,
            source,
            previousTitle,
            nextTitle: title,
        });
    }

    private preserveSpecificTitle(
        conversationId: string,
        incoming: ConversationData,
        source: string,
        existing?: ConversationData,
    ): void {
        const platformDefaultTitles = this.currentAdapter?.defaultTitles;
        const existingSpecificTitle =
            existing && !isGenericConversationTitle(existing.title, { platformDefaultTitles }) ? existing.title : null;
        const rememberedSpecificTitle = this.specificTitleCache.get(conversationId) ?? null;
        const fallbackSpecificTitle = existingSpecificTitle ?? rememberedSpecificTitle;

        if (fallbackSpecificTitle && isGenericConversationTitle(incoming.title, { platformDefaultTitles })) {
            const previousIncomingTitle = incoming.title;
            incoming.title = fallbackSpecificTitle;
            logger.info('Preserved specific title over generic incoming title', {
                conversationId,
                source,
                preservationSource: existingSpecificTitle ? 'existing-cache' : 'specific-title-cache',
                preservedTitle: fallbackSpecificTitle,
                incomingTitle: previousIncomingTitle,
            });
        }

        if (!isGenericConversationTitle(incoming.title, { platformDefaultTitles })) {
            this.rememberSpecificTitle(conversationId, incoming.title, source);
        }
    }

    private processQueuedMessages(): void {
        const globalQueue = (this.globalRef as any).__BLACKIYA_CAPTURE_QUEUE__;
        const windowQueue = (this.windowRef as any).__BLACKIYA_CAPTURE_QUEUE__;
        const queue = (Array.isArray(globalQueue) ? globalQueue : windowQueue) as unknown[];
        if (!Array.isArray(queue) || queue.length === 0) {
            return;
        }

        // Take ownership up front so retries don't double-process already-dequeued messages.
        (this.globalRef as any).__BLACKIYA_CAPTURE_QUEUE__ = [];
        (this.windowRef as any).__BLACKIYA_CAPTURE_QUEUE__ = [];

        for (const message of queue) {
            const typed = message as Record<string, unknown> | null;
            if (
                typed?.type === 'LLM_CAPTURE_DATA_INTERCEPTED' &&
                typeof typed.data === 'string' &&
                resolveTokenValidationFailureReason(typed) === null
            ) {
                try {
                    this.handleInterceptedData(typed);
                } catch (error) {
                    logger.warn('Failed to process queued intercepted message', {
                        error: error instanceof Error ? error.message : String(error),
                    });
                }
            }
        }
    }

    private processQueuedLogMessages(): void {
        const globalQueue = (this.globalRef as any).__BLACKIYA_LOG_QUEUE__;
        const windowQueue = (this.windowRef as any).__BLACKIYA_LOG_QUEUE__;
        const queue = (Array.isArray(globalQueue) ? globalQueue : windowQueue) as unknown[];
        if (!Array.isArray(queue) || queue.length === 0) {
            return;
        }

        // Take ownership up front so retries don't double-process already-dequeued messages.
        (this.globalRef as any).__BLACKIYA_LOG_QUEUE__ = [];
        (this.windowRef as any).__BLACKIYA_LOG_QUEUE__ = [];

        for (const message of queue) {
            const typed = message as Record<string, unknown> | null;
            if (typed?.type === 'LLM_LOG_ENTRY' && resolveTokenValidationFailureReason(typed) === null) {
                try {
                    this.handleLogEntry((typed as { payload?: unknown }).payload);
                } catch (error) {
                    logger.warn('Failed to process queued log message', {
                        error: error instanceof Error ? error.message : String(error),
                    });
                }
            }
        }
    }
}
