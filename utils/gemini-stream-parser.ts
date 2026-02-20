import { parseBatchexecuteResponse } from '@/utils/google-rpc';
import { collectLikelyTextCandidates } from '@/utils/text-candidate-collector';
import { dedupePreserveOrder } from '@/utils/text-utils';
import { isGenericConversationTitle } from '@/utils/title-resolver';

const GEMINI_CONVERSATION_ID_REGEX = /\bc_([a-zA-Z0-9_-]{8,})\b/;
const ISO_DATE_REGEX = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

const isLikelyGeminiText = (value: string): boolean => {
    const trimmed = value.trim();
    if (trimmed.length < 8 || trimmed.length > 12000) {
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
    if (ISO_DATE_REGEX.test(trimmed)) {
        return false;
    }
    if (!/[A-Za-z]/.test(trimmed)) {
        return false;
    }
    if (/^[\w.-]+$/.test(trimmed) && !trimmed.includes(' ') && trimmed.length < 24) {
        return false;
    }
    if (/^[[\]{}(),:;._\-+=/\\|`~!@#$%^&*<>?]+$/.test(trimmed)) {
        return false;
    }
    return true;
};

const GEMINI_TEXT_PREFERRED_KEYS = ['text', 'delta', 'content', 'message', 'output_text', 'part', 'parts', 'summary'];

const extractConversationIdFromPayload = (payload: string): string | undefined => {
    const match = payload.match(GEMINI_CONVERSATION_ID_REGEX);
    return match?.[1];
};

const isLikelyGeminiTitle = (value: string): boolean => {
    const trimmed = value.trim().replace(/\s+/g, ' ');
    if (trimmed.length < 3 || trimmed.length > 180) {
        return false;
    }
    if (!/[A-Za-z]/.test(trimmed)) {
        return false;
    }
    if (ISO_DATE_REGEX.test(trimmed)) {
        return false;
    }
    if (/^v\d+$/i.test(trimmed)) {
        return false;
    }
    if (isGenericConversationTitle(trimmed)) {
        return false;
    }
    return true;
};

const collectGeminiTitleCandidates = (node: unknown, out: string[], depth = 0) => {
    if (depth > 8 || out.length > 20) {
        return;
    }
    if (!node || typeof node !== 'object') {
        return;
    }
    if (Array.isArray(node)) {
        for (const child of node) {
            collectGeminiTitleCandidates(child, out, depth + 1);
        }
        return;
    }

    const obj = node as Record<string, unknown>;
    const key11 = obj['11'];
    if (Array.isArray(key11)) {
        const first = key11.find((item): item is string => typeof item === 'string');
        if (first && isLikelyGeminiTitle(first)) {
            out.push(first.trim().replace(/\s+/g, ' '));
        }
    }

    for (const value of Object.values(obj)) {
        collectGeminiTitleCandidates(value, out, depth + 1);
    }
};

export type GeminiStreamSignals = {
    conversationId?: string;
    textCandidates: string[];
    titleCandidates: string[];
};

export const extractGeminiStreamSignalsFromBuffer = (
    buffer: string,
    seenPayloads: Set<string>,
): GeminiStreamSignals => {
    const results = parseBatchexecuteResponse(buffer);
    const textCandidates: string[] = [];
    const titleCandidates: string[] = [];
    let conversationId: string | undefined;

    for (const result of results) {
        const payload = typeof result.payload === 'string' ? result.payload : null;
        if (!payload || seenPayloads.has(payload)) {
            continue;
        }

        seenPayloads.add(payload);

        if (!conversationId) {
            conversationId = extractConversationIdFromPayload(payload);
        }

        try {
            const parsed = JSON.parse(payload);
            textCandidates.push(
                ...collectLikelyTextCandidates(parsed, {
                    preferredKeys: GEMINI_TEXT_PREFERRED_KEYS,
                    maxDepth: 8,
                    maxCandidates: 120,
                    isLikelyText: isLikelyGeminiText,
                }),
            );
            collectGeminiTitleCandidates(parsed, titleCandidates);
        } catch {
            // Ignore partial payloads that are not valid JSON yet.
        }
    }

    return {
        conversationId,
        textCandidates: dedupePreserveOrder(textCandidates),
        titleCandidates: dedupePreserveOrder(titleCandidates),
    };
};
