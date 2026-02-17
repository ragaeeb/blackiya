import { parseBatchexecuteResponse } from '@/utils/google-rpc';

const GEMINI_CONVERSATION_ID_REGEX = /\bc_([a-zA-Z0-9_-]{8,})\b/;
const ISO_DATE_REGEX = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

function isLikelyGeminiText(value: string): boolean {
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
}

function collectLikelyTextValues(node: unknown, out: string[], depth = 0): void {
    if (depth > 8 || out.length > 120) {
        return;
    }

    if (typeof node === 'string') {
        if (isLikelyGeminiText(node)) {
            out.push(node.trim());
        }
        return;
    }

    if (!node || typeof node !== 'object') {
        return;
    }

    if (Array.isArray(node)) {
        for (const child of node) {
            collectLikelyTextValues(child, out, depth + 1);
        }
        return;
    }

    const obj = node as Record<string, unknown>;
    const preferredKeys = ['text', 'delta', 'content', 'message', 'output_text', 'part', 'parts', 'summary'];
    for (const key of preferredKeys) {
        if (key in obj) {
            collectLikelyTextValues(obj[key], out, depth + 1);
        }
    }

    for (const value of Object.values(obj)) {
        collectLikelyTextValues(value, out, depth + 1);
    }
}

function extractConversationIdFromPayload(payload: string): string | undefined {
    const match = payload.match(GEMINI_CONVERSATION_ID_REGEX);
    return match?.[1];
}

function dedupeText(values: string[]): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const value of values) {
        if (seen.has(value)) {
            continue;
        }
        seen.add(value);
        out.push(value);
    }
    return out;
}

export type GeminiStreamSignals = {
    conversationId?: string;
    textCandidates: string[];
};

export function extractGeminiStreamSignalsFromBuffer(buffer: string, seenPayloads: Set<string>): GeminiStreamSignals {
    const results = parseBatchexecuteResponse(buffer);
    const textCandidates: string[] = [];
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
            collectLikelyTextValues(parsed, textCandidates);
        } catch {
            // Ignore partial payloads that are not valid JSON yet.
        }
    }

    return {
        conversationId,
        textCandidates: dedupeText(textCandidates),
    };
}
