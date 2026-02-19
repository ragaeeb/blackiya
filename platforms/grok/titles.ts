import { logger } from '@/utils/logger';
import { grokState } from './state';

export const isTitlesEndpoint = (url: string): boolean => {
    const isTitles = url.includes('GrokHistory');
    if (isTitles) {
        logger.info('[Blackiya/Grok/Titles] Detected titles endpoint');
    }
    return isTitles;
};

/**
 * Parse a GrokHistory response and return a map of restId -> title.
 * Retroactively patches any active conversation objects already in state.
 */
const parseTitlesResponse = (data: string, url: string): Map<string, string> | null => {
    try {
        logger.info('[Blackiya/Grok/Titles] Attempting to parse titles from:', url);
        const parsed = JSON.parse(data);
        const historyData = parsed?.data?.grok_conversation_history;

        if (!historyData || !Array.isArray(historyData.items)) {
            logger.info('[Blackiya/Grok/Titles] No conversation history items found');
            return null;
        }

        const titles = new Map<string, string>();
        for (const item of historyData.items) {
            const restId = item?.grokConversation?.rest_id;
            const title = item?.title;
            if (typeof restId !== 'string' || typeof title !== 'string') {
                continue;
            }

            titles.set(restId, title);

            const activeObj = grokState.activeConversations.get(restId);
            if (activeObj && activeObj.title !== title) {
                activeObj.title = title;
                logger.info(
                    `[Blackiya/Grok/Titles] Retroactively updated title for active conversation: ${restId} -> "${title}"`,
                );
            }
        }

        logger.info(`[Blackiya/Grok/Titles] Extracted ${titles.size} conversation titles`);
        return titles;
    } catch (e) {
        logger.error('[Blackiya/Grok/Titles] Failed to parse titles:', e);
        return null;
    }
};

/**
 * Handle a GrokHistory endpoint response: populate `grokState.conversationTitles`
 * and return `true` so the caller knows to stop processing.
 */
export const tryHandleGrokTitlesEndpoint = (data: string | any, url: string): boolean => {
    if (!isTitlesEndpoint(url)) {
        return false;
    }

    const dataStr = typeof data === 'string' ? data : JSON.stringify(data);
    const titles = parseTitlesResponse(dataStr, url);
    if (titles) {
        for (const [id, title] of titles) {
            grokState.conversationTitles.set(id, title);
        }
        logger.info(`[Blackiya/Grok] Title cache now contains ${grokState.conversationTitles.size} entries`);
    } else {
        logger.info('[Blackiya/Grok/Titles] Failed to extract titles from this response');
    }
    return true;
};
