import { chatGPTAdapter } from '@/platforms/chatgpt';
import { collectLikelyTextCandidates } from '@/utils/text-candidate-collector';

const PREFERRED_TEXT_KEYS = ['text', 'delta', 'content', 'message', 'output_text', 'token', 'part'] as const;

const isLikelyReadableToken = (value: string): boolean => {
    const trimmed = value.trim();
    if (trimmed.length < 2 || trimmed.length > 4000) {
        return false;
    }
    if (/^v\d+$/i.test(trimmed)) {
        return false;
    }
    if (/^[a-f0-9-]{24,}$/i.test(trimmed)) {
        return false;
    }
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
        return false;
    }
    if (/^[[\]{}(),:;._\-+=/\\|`~!@#$%^&*<>?]+$/.test(trimmed)) {
        return false;
    }
    return true;
};

/** Extracts the most likely human-readable text tokens from an arbitrary SSE JSON payload. */
export const extractLikelyTextFromSsePayload = (payload: string): string[] => {
    try {
        const parsed = JSON.parse(payload);
        const values = collectLikelyTextCandidates(parsed, {
            preferredKeys: PREFERRED_TEXT_KEYS,
            maxDepth: 8,
            maxCandidates: 80,
            isLikelyText: isLikelyReadableToken,
        });
        const seen = new Set<string>();
        return values.filter((v) => {
            if (seen.has(v)) {
                return false;
            }
            seen.add(v);
            return true;
        });
    } catch {
        return [];
    }
};

/** Extracts the conversation title from a ChatGPT title_generation SSE frame. */
export const extractTitleFromSsePayload = (dataPayload: string): string | null => {
    try {
        const parsed = JSON.parse(dataPayload);
        if (
            parsed?.type === 'title_generation' &&
            typeof parsed?.title === 'string' &&
            parsed.title.trim().length > 0
        ) {
            return parsed.title.trim();
        }
    } catch {
        // not JSON or not a title frame
    }
    return null;
};

/**
 * Parses the running SSE buffer through the ChatGPT adapter and returns the
 * latest assistant text snapshot, or null if nothing readable is present yet.
 */
export const extractAssistantTextSnapshotFromSseBuffer = (sseBuffer: string): string | null => {
    const parsed = chatGPTAdapter.parseInterceptedData(sseBuffer, 'https://chatgpt.com/backend-api/f/conversation');
    if (!parsed) {
        return null;
    }

    const assistantMessages = Object.values(parsed.mapping)
        .map((node) => node.message)
        .filter(
            (m): m is NonNullable<(typeof parsed.mapping)[string]['message']> => !!m && m.author.role === 'assistant',
        );

    if (assistantMessages.length === 0) {
        return null;
    }

    const latest = assistantMessages[assistantMessages.length - 1];
    const text = (latest.content.parts ?? []).filter((p): p is string => typeof p === 'string').join('');
    const normalized = text.trim();
    return normalized.length === 0 || /^v\d+$/i.test(normalized) ? null : normalized;
};
