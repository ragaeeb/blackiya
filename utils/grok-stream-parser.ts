import { collectLikelyTextCandidates } from '@/utils/text-candidate-collector';
import { dedupePreserveOrder } from '@/utils/text-utils';

const GROK_CONVERSATION_ID_REGEX = /^[a-zA-Z0-9-]{8,128}$/;
const ISO_DATE_REGEX = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const TOOL_USAGE_CARD_ARGS_REGEX = /<xai:tool_args><!\[CDATA\[([\s\S]*?)\]\]><\/xai:tool_args>/i;
const GROK_METADATA_KEYS_TO_SKIP = new Set(['responseId', 'messageTag', 'messageStepId', 'toolUsageCardId']);
const GROK_PREFERRED_TEXT_KEYS = ['message', 'text', 'delta', 'content', 'output_text', 'summary', 'final_message'];

const extractToolUsageCardMessage = (value: string): string | null => {
    if (!value.includes('<xai:tool_usage_card')) {
        return null;
    }
    const argsMatch = value.match(TOOL_USAGE_CARD_ARGS_REGEX);
    const rawArgs = argsMatch?.[1]?.trim();
    if (!rawArgs) {
        return null;
    }
    try {
        const parsed = JSON.parse(rawArgs) as { message?: unknown };
        if (typeof parsed.message === 'string' && parsed.message.trim().length > 0) {
            return parsed.message.trim();
        }
    } catch {
        return null;
    }
    return null;
};

const normalizeCandidateText = (value: string): string => {
    return extractToolUsageCardMessage(value) ?? value;
};

const isLikelyGrokText = (value: string): boolean => {
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
};

const normalizeGrokTextCandidate = (value: string) => normalizeCandidateText(value).replace(/\r\n/g, '\n');

const pushReasoningIfText = (value: unknown, out: string[]) => {
    if (typeof value !== 'string' || !isLikelyGrokText(value)) {
        return;
    }
    out.push(value.trim());
};

const resolveHeaderTitle = (headerObj: Record<string, unknown>): string => {
    return typeof headerObj.header === 'string' ? headerObj.header.trim() : '';
};

const collectDeepSearchStepMessages = (headerTitle: string, steps: unknown[], out: string[]) => {
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
};

const collectDeepSearchHeaderReasoning = (header: unknown, out: string[]) => {
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
};

const collectDeepSearchReasoning = (headers: unknown, out: string[]) => {
    if (!Array.isArray(headers)) {
        return;
    }
    for (const header of headers) {
        collectDeepSearchHeaderReasoning(header, out);
    }
};

const collectReasoningFromObject = (obj: Record<string, unknown>, out: string[]) => {
    pushReasoningIfText(obj.thinking_trace, out);
    pushReasoningIfText(obj.reasoning, out);
    if (obj.isThinking === true && typeof obj.token === 'string') {
        pushReasoningIfText(normalizeCandidateText(obj.token), out);
    }
    collectDeepSearchReasoning(obj.deepsearch_headers, out);
};

const collectReasoningValues = (node: unknown, out: string[], depth = 0) => {
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
};

const extractConversationIdFromNode = (node: unknown): string | undefined => {
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
};

const normalizeNdjsonLine = (rawLine: string): string => {
    const trimmed = rawLine.trim();
    if (!trimmed) {
        return '';
    }
    if (trimmed.startsWith('data:')) {
        return trimmed.slice('data:'.length).trim();
    }
    return trimmed;
};

export type GrokStreamSignals = {
    conversationId?: string;
    textCandidates: string[];
    reasoningCandidates: string[];
    remainingBuffer: string;
    seenPayloadKeys: string[];
};

export const extractGrokStreamSignalsFromBuffer = (buffer: string, seenPayloads: Set<string>): GrokStreamSignals => {
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

        textCandidates.push(
            ...collectLikelyTextCandidates(parsed, {
                preferredKeys: GROK_PREFERRED_TEXT_KEYS,
                skipKeys: GROK_METADATA_KEYS_TO_SKIP,
                maxDepth: 9,
                maxCandidates: 160,
                normalize: normalizeGrokTextCandidate,
                preserveWhitespace: true,
                shouldSkipEntry: ({ key, value, parent }) =>
                    key === 'token' && parent.isThinking === true && typeof value === 'string',
                isLikelyText: isLikelyGrokText,
            }),
        );
        collectReasoningValues(parsed, reasoningCandidates);
    }

    return {
        conversationId,
        textCandidates: dedupePreserveOrder(textCandidates),
        reasoningCandidates: dedupePreserveOrder(reasoningCandidates),
        remainingBuffer,
        seenPayloadKeys,
    };
};
