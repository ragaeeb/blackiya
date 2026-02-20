/**
 * API URL candidate resolution for proactive fetch and snapshot replay.
 *
 * Pure functions — no runner state dependencies. They only need an adapter
 * and a conversation ID to produce URL lists.
 */

import type { LLMPlatform } from '@/platforms/types';

/**
 * Builds an ordered list of API fetch URL candidates for a conversation.
 * Includes the adapter's primary URL and any additional URLs, filtered to
 * same-origin only for security.
 */
export const getFetchUrlCandidates = (adapter: LLMPlatform, conversationId: string): string[] => {
    const urls: string[] = [];
    for (const url of adapter.buildApiUrls?.(conversationId) ?? []) {
        if (typeof url === 'string' && url.length > 0 && !urls.includes(url)) {
            urls.push(url);
        }
    }
    const primary = adapter.buildApiUrl?.(conversationId);
    if (primary && !urls.includes(primary)) {
        urls.unshift(primary);
    }
    const currentOrigin = window.location.origin;
    return urls.filter((url) => {
        try {
            return new URL(url, currentOrigin).origin === currentOrigin;
        } catch {
            return false;
        }
    });
};

const GROK_REPLAY_URL_TEMPLATES = [
    (cid: string) => `https://grok.com/rest/app-chat/conversations/${cid}/load-responses`,
    (cid: string) => `https://grok.com/rest/app-chat/conversations/${cid}/response-node?includeThreads=true`,
    (cid: string) => `https://grok.com/rest/app-chat/conversations_v2/${cid}?includeWorkspaces=true&includeTaskResult=true`,
] as const;

/**
 * Returns candidate URLs for replaying a raw snapshot capture. For Grok,
 * appends platform-specific alternate endpoint URLs. For other platforms,
 * returns just the original snapshot URL.
 */
export const getRawSnapshotReplayUrls = (
    adapter: LLMPlatform,
    conversationId: string,
    rawSnapshot: { url: string },
): string[] => {
    const urls = [rawSnapshot.url];
    if (adapter.name !== 'Grok') {
        return urls;
    }
    for (const template of GROK_REPLAY_URL_TEMPLATES) {
        const candidate = template(conversationId);
        if (!urls.includes(candidate)) {
            urls.push(candidate);
        }
    }
    return urls;
};
