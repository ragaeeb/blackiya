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
import { getSessionToken, resolveTokenValidationFailureReason } from '@/utils/protocol/session-token';
import { isGenericConversationTitle } from '@/utils/title-resolver';
import type { ConversationData, Message, MessageNode } from '@/utils/types';

export class InterceptionManager {
    private static readonly BLOCKED_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
    private static readonly MAX_PENDING_TOKEN_MESSAGES = 300;
    private static readonly MAX_TOKEN_REVALIDATION_RETRIES = 40;
    private readonly conversationCache: LRUCache<string, ConversationData>;
    private readonly specificTitleCache: LRUCache<string, string>;
    private currentAdapter: LLMPlatform | null = null;
    private readonly windowRef: Window;
    private readonly globalRef: typeof globalThis;
    private lastInvalidTokenLogAtMs = 0;
    private pendingTokenRevalidationMessages: Array<Record<string, unknown>> = [];
    private pendingTokenRevalidationTimer: ReturnType<typeof setTimeout> | null = null;
    private pendingTokenRevalidationRetryCount = 0;
    private pendingTokenRevalidationRetryLimitReached = false;

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

    public start() {
        this.windowRef.addEventListener('message', this.handleMessage);
        this.processQueuedMessages();
        this.processQueuedLogMessages();
        this.processPendingTokenRevalidationMessages();
        // In case queued messages are added before the listener is attached
        setTimeout(() => {
            this.processQueuedMessages();
            this.processQueuedLogMessages();
            this.processPendingTokenRevalidationMessages();
        }, 0);
        // #region agent log — diagnostic: confirm message listener is attached
        logger.info('[InterceptionManager] Message listener attached', {
            platform: this.currentAdapter?.name ?? 'none',
        });
        // #endregion
    }

    public flushQueuedMessages() {
        this.processQueuedMessages();
        this.processPendingTokenRevalidationMessages();
    }

    public stop() {
        this.windowRef.removeEventListener('message', this.handleMessage);
        if (this.pendingTokenRevalidationTimer !== null) {
            clearTimeout(this.pendingTokenRevalidationTimer);
            this.pendingTokenRevalidationTimer = null;
        }
        this.pendingTokenRevalidationRetryCount = 0;
        this.pendingTokenRevalidationRetryLimitReached = false;
    }

    public getConversation(id: string): ConversationData | undefined {
        const cached = this.conversationCache.get(id);
        if (!cached) {
            return undefined;
        }
        this.preserveSpecificTitle(id, cached, 'cache-read');
        return cached;
    }

    public ingestInterceptedData(message: {
        type?: string;
        url: string;
        data: string;
        platform?: string;
        promptHint?: string;
    }) {
        this.handleInterceptedData({
            type: 'LLM_CAPTURE_DATA_INTERCEPTED',
            ...message,
        });
    }

    public ingestConversationData(data: ConversationData, source = 'snapshot') {
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

    private handleMessage = (event: MessageEvent) => {
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
                if (this.tryQueueMessageForTokenRevalidation(message, messageType, tokenFailureReason)) {
                    return;
                }
                this.logTokenValidationDrop(messageType, tokenFailureReason);
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

    private handleLogEntry(payload: any) {
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
            if (ctx === 'i') {
                logger.debug(prefixedMsg, ...extra);
            } else {
                logger.info(prefixedMsg, ...extra);
            }
        }
    }

    private logTokenValidationDrop(messageType: string, reason: string) {
        const now = Date.now();
        if (now - this.lastInvalidTokenLogAtMs <= 1500) {
            return;
        }
        this.lastInvalidTokenLogAtMs = now;
        logger.debug('Dropped interceptor message due to token validation failure', {
            reason,
            messageType,
        });
    }

    private tryQueueMessageForTokenRevalidation(
        message: Record<string, unknown> | null,
        messageType: string,
        reason: string,
    ): boolean {
        if (!message || reason !== 'missing-message-token') {
            return false;
        }
        if (this.pendingTokenRevalidationMessages.length >= InterceptionManager.MAX_PENDING_TOKEN_MESSAGES) {
            this.logTokenValidationDrop(messageType, 'missing-message-token-queue-full');
            return true;
        }
        this.pendingTokenRevalidationMessages.push(message);
        this.logTokenValidationDrop(messageType, 'missing-message-token-queued-for-revalidation');
        this.schedulePendingTokenRevalidation();
        return true;
    }

    private schedulePendingTokenRevalidation() {
        if (this.pendingTokenRevalidationTimer !== null) {
            return;
        }
        this.pendingTokenRevalidationTimer = setTimeout(() => {
            this.pendingTokenRevalidationTimer = null;
            this.processPendingTokenRevalidationMessages();
        }, 50);
    }

    private processPendingTokenRevalidationMessages() {
        if (this.pendingTokenRevalidationMessages.length === 0) {
            return;
        }
        const sessionToken = this.resolvePendingRevalidationSessionToken();
        if (!sessionToken) {
            if (this.pendingTokenRevalidationRetryLimitReached) {
                this.pendingTokenRevalidationMessages = [];
                this.pendingTokenRevalidationRetryLimitReached = false;
            }
            return;
        }

        const pending = this.pendingTokenRevalidationMessages;
        this.pendingTokenRevalidationMessages = [];
        for (const typed of pending) {
            if (!this.applyMissingTokenIfNeeded(typed, sessionToken)) {
                continue;
            }
            this.processPendingTokenRevalidationMessage(typed);
        }
    }

    private resolvePendingRevalidationSessionToken(): string | null {
        const sessionToken = getSessionToken();
        if (sessionToken) {
            this.pendingTokenRevalidationRetryCount = 0;
            this.pendingTokenRevalidationRetryLimitReached = false;
            return sessionToken;
        }
        this.pendingTokenRevalidationRetryCount += 1;
        if (this.pendingTokenRevalidationRetryCount >= InterceptionManager.MAX_TOKEN_REVALIDATION_RETRIES) {
            this.pendingTokenRevalidationRetryCount = 0;
            this.pendingTokenRevalidationRetryLimitReached = true;
            if (this.pendingTokenRevalidationTimer !== null) {
                clearTimeout(this.pendingTokenRevalidationTimer);
                this.pendingTokenRevalidationTimer = null;
            }
            logger.warn('Pending token revalidation retry limit reached; dropping pending messages', {
                pendingCount: this.pendingTokenRevalidationMessages.length,
            });
            return null;
        }
        this.schedulePendingTokenRevalidation();
        return null;
    }

    private applyMissingTokenIfNeeded(message: Record<string, unknown>, sessionToken: string | null): boolean {
        if (typeof message.__blackiyaToken === 'string' && message.__blackiyaToken.length > 0) {
            return true;
        }
        if (!sessionToken) {
            return false;
        }
        message.__blackiyaToken = sessionToken;
        return true;
    }

    private processPendingTokenRevalidationMessage(message: Record<string, unknown>) {
        const messageType = typeof message.type === 'string' ? message.type : '';
        const tokenFailureReason = resolveTokenValidationFailureReason(message);
        if (tokenFailureReason !== null) {
            this.logTokenValidationDrop(messageType, tokenFailureReason);
            return;
        }

        try {
            if (messageType === 'LLM_CAPTURE_DATA_INTERCEPTED' && typeof message.data === 'string') {
                this.handleInterceptedData(message);
            } else if (messageType === 'LLM_LOG_ENTRY') {
                this.handleLogEntry((message as { payload?: unknown }).payload);
            }
        } catch (error) {
            logger.warn('Failed to process pending token revalidation message', {
                error: error instanceof Error ? error.message : String(error),
                messageType,
            });
        }
    }

    private getQueue(queueKey: '__BLACKIYA_CAPTURE_QUEUE__' | '__BLACKIYA_LOG_QUEUE__'): unknown[] {
        const globalQueue = (this.globalRef as any)[queueKey];
        const windowQueue = (this.windowRef as any)[queueKey];
        const queue = (Array.isArray(globalQueue) ? globalQueue : windowQueue) as unknown[];
        if (!Array.isArray(queue) || queue.length === 0) {
            return [];
        }

        (this.globalRef as any)[queueKey] = [];
        (this.windowRef as any)[queueKey] = [];
        return queue;
    }

    private getTokenValidationFailure(typed: Record<string, unknown>): string | null {
        const tokenFailureReason = resolveTokenValidationFailureReason(typed);
        if (tokenFailureReason === null) {
            return null;
        }
        const messageType = String(typed.type ?? '');
        if (!this.tryQueueMessageForTokenRevalidation(typed, messageType, tokenFailureReason)) {
            this.logTokenValidationDrop(messageType, tokenFailureReason);
        }
        return tokenFailureReason;
    }

    private handleInterceptedData(message: any) {
        logger.debug('Intercepted payload received', {
            platform: this.currentAdapter?.name ?? 'unknown',
            size: typeof message.data === 'string' ? message.data.length : 0,
        });

        if (!this.currentAdapter) {
            logger.warn('No currentAdapter in manager, ignoring message');
            return;
        }

        try {
            const data = this.currentAdapter.parseInterceptedData(message.data, message.url);
            this.applyGrokPromptHintIfNeeded(data, message);

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
                    logger.debug('Metadata-only response (no messages yet)', payload);
                } else {
                    logger.warn('Failed to parse conversation ID from intercepted data', payload);
                }
            }
        } catch (error) {
            logger.error('Error parsing intercepted data:', error);
        }
    }

    private applyGrokPromptHintIfNeeded(data: ConversationData | null, message: any) {
        if (!data) {
            return;
        }
        const platform = typeof message?.platform === 'string' ? message.platform : (this.currentAdapter?.name ?? '');
        if (platform !== 'Grok') {
            return;
        }
        const promptHint = typeof message?.promptHint === 'string' ? message.promptHint.trim() : '';
        if (!promptHint) {
            return;
        }
        if (this.hasNonEmptyUserPrompt(data)) {
            return;
        }

        const assistantNodeId = this.findLatestAssistantNodeId(data);
        if (!assistantNodeId) {
            return;
        }
        this.upsertPromptHintUserNode(data, assistantNodeId, promptHint);
    }

    private hasNonEmptyUserPrompt(data: ConversationData): boolean {
        for (const node of Object.values(data.mapping)) {
            const message = node.message;
            if (!message || message.author.role !== 'user') {
                continue;
            }
            if (this.extractMessageText(message).length > 0) {
                return true;
            }
        }
        return false;
    }

    private extractMessageText(message: Message): string {
        if (Array.isArray(message.content?.parts)) {
            const text = message.content.parts
                .filter((part) => typeof part === 'string')
                .join('\n')
                .trim();
            if (text.length > 0) {
                return text;
            }
        }
        if (typeof message.content?.content === 'string') {
            return message.content.content.trim();
        }
        return '';
    }

    private findLatestAssistantNodeId(data: ConversationData): string | null {
        const current = data.mapping[data.current_node];
        if (current?.message?.author.role === 'assistant') {
            return current.id;
        }

        let latestNodeId: string | null = null;
        let latestTimestamp = Number.NEGATIVE_INFINITY;
        for (const node of Object.values(data.mapping)) {
            const message = node.message;
            if (!message || message.author.role !== 'assistant') {
                continue;
            }
            const timestamp = message.update_time ?? message.create_time ?? Number.NEGATIVE_INFINITY;
            if (timestamp >= latestTimestamp) {
                latestTimestamp = timestamp;
                latestNodeId = node.id;
            }
        }
        return latestNodeId;
    }

    private findRootNodeId(data: ConversationData): string {
        const rootNode = Object.values(data.mapping).find((node) => node.parent === null);
        if (rootNode) {
            return rootNode.id;
        }
        const fallbackRootId = `root-${data.conversation_id}`;
        if (!data.mapping[fallbackRootId]) {
            data.mapping[fallbackRootId] = { id: fallbackRootId, message: null, parent: null, children: [] };
        }
        return fallbackRootId;
    }

    private buildPromptHintMessage(
        nodeId: string,
        assistantNode: MessageNode,
        promptHint: string,
        data: ConversationData,
    ): Message {
        const timestamp = assistantNode.message?.create_time ?? data.create_time ?? Date.now() / 1000;
        return {
            id: nodeId,
            author: { role: 'user', name: 'User', metadata: {} },
            create_time: timestamp,
            update_time: timestamp,
            content: { content_type: 'text', parts: [promptHint] },
            status: 'finished_successfully',
            end_turn: true,
            weight: 1,
            metadata: { sender: 'user', source: 'prompt_hint' },
            recipient: 'all',
            channel: null,
        };
    }

    private upsertPromptHintUserNode(data: ConversationData, assistantNodeId: string, promptHint: string) {
        const assistantNode = data.mapping[assistantNodeId];
        if (!assistantNode || !assistantNode.message) {
            return;
        }

        const existingParentId = assistantNode.parent;
        if (existingParentId && data.mapping[existingParentId]?.message === null) {
            data.mapping[existingParentId].message = this.buildPromptHintMessage(
                existingParentId,
                assistantNode,
                promptHint,
                data,
            );
            return;
        }

        const rootId = this.findRootNodeId(data);
        const hintNodeId = `${assistantNodeId}-prompt-hint`;
        const parentForHint = existingParentId ?? rootId;

        if (!data.mapping[hintNodeId]) {
            data.mapping[hintNodeId] = {
                id: hintNodeId,
                message: null,
                parent: parentForHint,
                children: [],
            };
        }

        const hintNode = data.mapping[hintNodeId];
        if (!hintNode.children.includes(assistantNodeId)) {
            hintNode.children.push(assistantNodeId);
        }
        hintNode.message = this.buildPromptHintMessage(hintNodeId, assistantNode, promptHint, data);

        if (existingParentId && data.mapping[existingParentId]) {
            const parentNode = data.mapping[existingParentId];
            parentNode.children = parentNode.children.filter((childId) => childId !== assistantNodeId);
            if (!parentNode.children.includes(hintNodeId)) {
                parentNode.children.push(hintNodeId);
            }
        } else {
            const rootNode = data.mapping[rootId];
            if (!rootNode.children.includes(hintNodeId)) {
                rootNode.children.push(hintNodeId);
            }
        }

        assistantNode.parent = hintNodeId;
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

        const isGeminiAuxMiss =
            url.includes('/_/BardChatUi/data/batchexecute') ||
            url.includes('/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate');

        const isExpectedAuxMiss =
            isGeminiAuxMiss ||
            url.includes('/rest/app-chat/conversations_v2/') ||
            url.includes('/rest/app-chat/conversations/new') ||
            (url.includes('/rest/app-chat/conversations/') && url.includes('/response-node'));

        return isExpectedAuxMiss ? 'info' : 'warn';
    }

    private rememberSpecificTitle(conversationId: string, title: string, source: string) {
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
    ) {
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

    private processQueuedMessages() {
        const queue = this.getQueue('__BLACKIYA_CAPTURE_QUEUE__');
        if (queue.length === 0) {
            return;
        }

        for (const message of queue) {
            const typed = message as Record<string, unknown> | null;
            if (typed?.type !== 'LLM_CAPTURE_DATA_INTERCEPTED' || typeof typed.data !== 'string') {
                continue;
            }
            if (this.getTokenValidationFailure(typed) !== null) {
                continue;
            }
            try {
                this.handleInterceptedData(typed);
            } catch (error) {
                logger.warn('Failed to process queued intercepted message', {
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }
    }

    private processQueuedLogMessages() {
        const queue = this.getQueue('__BLACKIYA_LOG_QUEUE__');
        if (queue.length === 0) {
            return;
        }

        for (const message of queue) {
            const typed = message as Record<string, unknown> | null;
            if (typed?.type !== 'LLM_LOG_ENTRY') {
                continue;
            }
            if (this.getTokenValidationFailure(typed) !== null) {
                continue;
            }
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
