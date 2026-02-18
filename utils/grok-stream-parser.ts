import { dedupePreserveOrder } from '@/utils/text-utils';

const GROK_CONVERSATION_ID_REGEX = /^[a-zA-Z0-9-]{8,128}$/;
const ISO_DATE_REGEX = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

function isLikelyGrokText(value: string): boolean {
    const trimmed = value.trim();
    if (trimmed.length < 2 || trimmed.length > 14000) {
        return false;
    }
    if (/^v\d+$/i.test(trimmed)) {
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
    if (/^[a-f0-9-]{24,}$/i.test(trimmed)) {
        return false;
    }
    if (/^[[\]{}(),:;._\-+=/\\|`~!@#$%^&*<>?]+$/.test(trimmed)) {
        return false;
    }
    return true;
}

function collectLikelyTextValues(node: unknown, out: string[], depth = 0): void {
    if (depth > 9 || out.length > 160) {
        return;
    }
    if (typeof node === 'string') {
        if (isLikelyGrokText(node)) {
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
    const preferredKeys = ['message', 'text', 'delta', 'content', 'output_text', 'summary', 'final_message'];
    for (const key of preferredKeys) {
        if (key in obj) {
            collectLikelyTextValues(obj[key], out, depth + 1);
        }
    }
    for (const value of Object.values(obj)) {
        collectLikelyTextValues(value, out, depth + 1);
    }
}

function pushReasoningIfText(value: unknown, out: string[]): void {
    if (typeof value !== 'string' || !isLikelyGrokText(value)) {
        return;
    }
    out.push(value.trim());
}

function resolveHeaderTitle(headerObj: Record<string, unknown>): string {
    return typeof headerObj.header === 'string' ? headerObj.header.trim() : '';
}

function collectDeepSearchStepMessages(headerTitle: string, steps: unknown[], out: string[]): void {
    for (const step of steps) {
        if (!step || typeof step !== 'object') {
            continue;
        }
        const finalMessage = (step as Record<string, unknown>).final_message;
        if (typeof finalMessage !== 'string' || !isLikelyGrokText(finalMessage)) {
            continue;
        }
        const body = finalMessage.trim();
        out.push(headerTitle.length > 0 ? `${headerTitle}: ${body}` : body);
    }
}

function collectDeepSearchHeaderReasoning(header: unknown, out: string[]): void {
    if (!header || typeof header !== 'object') {
        return;
    }
    const headerObj = header as Record<string, unknown>;
    const steps = headerObj.steps;
    if (!Array.isArray(steps)) {
        return;
    }
    const headerTitle = resolveHeaderTitle(headerObj);
    collectDeepSearchStepMessages(headerTitle, steps, out);
}

function collectDeepSearchReasoning(headers: unknown, out: string[]): void {
    if (!Array.isArray(headers)) {
        return;
    }
    for (const header of headers) {
        collectDeepSearchHeaderReasoning(header, out);
    }
}

function collectReasoningFromObject(obj: Record<string, unknown>, out: string[]): void {
    pushReasoningIfText(obj.thinking_trace, out);
    pushReasoningIfText(obj.reasoning, out);
    collectDeepSearchReasoning(obj.deepsearch_headers, out);
}

function collectReasoningValues(node: unknown, out: string[], depth = 0): void {
    if (depth > 9 || out.length > 120 || !node || typeof node !== 'object') {
        return;
    }
    if (Array.isArray(node)) {
        for (const child of node) {
            collectReasoningValues(child, out, depth + 1);
        }
        return;
    }

    const obj = node as Record<string, unknown>;
    collectReasoningFromObject(obj, out);
    for (const value of Object.values(obj)) {
        collectReasoningValues(value, out, depth + 1);
    }
}

function extractConversationIdFromNode(node: unknown): string | undefined {
    if (!node || typeof node !== 'object') {
        return undefined;
    }
    const obj = node as Record<string, unknown>;
    const rootConversation = obj.conversation as Record<string, unknown> | undefined;
    const result = obj.result as Record<string, unknown> | undefined;
    const resultConversation = result?.conversation as Record<string, unknown> | undefined;
    const resultResponse = result?.response as Record<string, unknown> | undefined;
    const candidates: unknown[] = [
        obj.conversationId,
        obj.conversation_id,
        rootConversation?.conversationId,
        rootConversation?.conversation_id,
        result?.conversationId,
        result?.conversation_id,
        resultConversation?.conversationId,
        resultConversation?.conversation_id,
        resultResponse?.conversationId,
    ];

    for (const candidate of candidates) {
        if (typeof candidate !== 'string') {
            continue;
        }
        const trimmed = candidate.trim();
        if (GROK_CONVERSATION_ID_REGEX.test(trimmed)) {
            return trimmed;
        }
    }
    return undefined;
}

function normalizeNdjsonLine(rawLine: string): string {
    const trimmed = rawLine.trim();
    if (!trimmed) {
        return '';
    }
    if (trimmed.startsWith('data:')) {
        return trimmed.slice('data:'.length).trim();
    }
    return trimmed;
}

export type GrokStreamSignals = {
    conversationId?: string;
    textCandidates: string[];
    reasoningCandidates: string[];
    remainingBuffer: string;
    seenPayloadKeys: string[];
};

export function extractGrokStreamSignalsFromBuffer(buffer: string, seenPayloads: Set<string>): GrokStreamSignals {
    const normalized = buffer.replace(/\r\n/g, '\n');
    const lines = normalized.split('\n');
    const remainingBuffer = lines.pop() ?? '';
    const textCandidates: string[] = [];
    const reasoningCandidates: string[] = [];
    const seenPayloadKeys: string[] = [];
    let conversationId: string | undefined;

    for (const rawLine of lines) {
        const line = normalizeNdjsonLine(rawLine);
        if (!line || seenPayloads.has(line)) {
            continue;
        }

        let parsed: unknown;
        try {
            parsed = JSON.parse(line);
        } catch {
            continue;
        }

        seenPayloads.add(line);
        seenPayloadKeys.push(line);

        if (!conversationId) {
            conversationId = extractConversationIdFromNode(parsed);
        }

        collectLikelyTextValues(parsed, textCandidates);
        collectReasoningValues(parsed, reasoningCandidates);
    }

    return {
        conversationId,
        textCandidates: dedupePreserveOrder(textCandidates),
        reasoningCandidates: dedupePreserveOrder(reasoningCandidates),
        remainingBuffer,
        seenPayloadKeys,
    };
}
