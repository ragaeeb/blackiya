/**
 * Interception Manager
 *
 * Handles listening for intercepted data messages from the content script interceptor.
 * Parses raw data using the appropriate platform adapter.
 * Manages the LRU cache of validation conversation data.
 */

import type { LLMPlatform } from '@/platforms/types';
import { logger } from '@/utils/logger';
import { LRUCache } from '@/utils/lru-cache';
import type { ConversationData } from '@/utils/types';

export class InterceptionManager {
    private readonly conversationCache: LRUCache<string, ConversationData>;
    private currentAdapter: LLMPlatform | null = null;

    // Callback to notify the runner (and UI) that new valid data has been intercepted/cached
    private onDataCaptured: (conversationId: string) => void;

    constructor(onDataCaptured: (conversationId: string) => void) {
        this.conversationCache = new LRUCache<string, ConversationData>(10);
        this.onDataCaptured = onDataCaptured;
    }

    public updateAdapter(adapter: LLMPlatform | null) {
        this.currentAdapter = adapter;
    }

    public start(): void {
        window.addEventListener('message', this.handleMessage);
    }

    public stop(): void {
        window.removeEventListener('message', this.handleMessage);
    }

    public getConversation(id: string): ConversationData | undefined {
        return this.conversationCache.get(id);
    }

    private handleMessage = (event: MessageEvent): void => {
        if (event.source !== window) {
            return;
        }

        if (event.origin !== window.location.origin) {
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
        const prefixedMsg = `[${context ?? 'interceptor'}] ${logMessage}`;

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
        logger.info('Received intercepted data message');

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
                this.onDataCaptured(conversationId);
            } else {
                logger.warn('Failed to parse conversation ID from intercepted data');
            }
        } catch (error) {
            logger.error('Error parsing intercepted data:', error);
        }
    }
}
