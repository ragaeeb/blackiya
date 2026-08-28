import type { PlatformReadiness } from '@/platforms/types';
import { hashText } from '@/utils/hash';
import type { ConversationData } from '@/utils/types';

type JsonRecord = Record<string, unknown>;

const toRecord = (value: unknown): JsonRecord | null =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : null;

const notReady = (reason: string): PlatformReadiness => ({
    ready: false,
    terminal: false,
    reason,
    contentHash: null,
    latestAssistantTextLength: 0,
});

const hasCompleteHistory = (pagination: JsonRecord | null): boolean => {
    if (!pagination) {
        return false;
    }
    if (pagination.enabled === false) {
        return true;
    }
    return pagination.enabled === true && pagination.has_more_older === false && pagination.has_more_newer === false;
};

const resolveActiveQwenMessage = (data: ConversationData): JsonRecord | null => {
    const envelope = toRecord(data.raw_payload);
    const payloadData = toRecord(envelope?.data);
    const chat = toRecord(payloadData?.chat);
    const history = toRecord(chat?.history);
    const currentId =
        typeof payloadData?.currentId === 'string'
            ? payloadData.currentId
            : typeof history?.currentId === 'string'
              ? history.currentId
              : null;
    if (!currentId || currentId !== data.current_node) {
        return null;
    }
    if (Array.isArray(chat?.messages)) {
        const match = chat.messages.map(toRecord).find((message) => message?.id === currentId);
        if (match) {
            return match;
        }
    }
    return toRecord(toRecord(history?.messages)?.[currentId]);
};

const resolvePagination = (data: ConversationData): JsonRecord | null => {
    const envelope = toRecord(data.raw_payload);
    const payloadData = toRecord(envelope?.data);
    const chat = toRecord(payloadData?.chat);
    const history = toRecord(chat?.history);
    return toRecord(history?.pagination);
};

const resolveAnswerItems = (message: JsonRecord): JsonRecord[] =>
    Array.isArray(message.content_list)
        ? message.content_list
              .map(toRecord)
              .filter((item): item is JsonRecord => !!item && item.phase === 'answer' && item.role === 'assistant')
        : [];

export const evaluateQwenReadiness = (data: ConversationData): PlatformReadiness => {
    if (!hasCompleteHistory(resolvePagination(data))) {
        return notReady('history-incomplete');
    }
    const activeMessage = resolveActiveQwenMessage(data);
    if (activeMessage?.role !== 'assistant') {
        return notReady('assistant-missing');
    }
    if (activeMessage.error !== null) {
        return notReady('assistant-error');
    }
    if (activeMessage.is_stop !== false) {
        return notReady(activeMessage.is_stop === true ? 'assistant-stopped' : 'assistant-state-unknown');
    }
    if (activeMessage.done !== true) {
        return notReady('assistant-in-progress');
    }
    const answerItems = resolveAnswerItems(activeMessage);
    if (answerItems.some((item) => item.status !== 'finished')) {
        return notReady('assistant-in-progress');
    }
    const answerText = answerItems
        .map((item) => (typeof item.content === 'string' ? item.content : ''))
        .join('')
        .trim()
        .normalize('NFC');
    if (answerItems.length === 0 || answerText.length === 0) {
        return notReady('assistant-answer-missing');
    }
    return {
        ready: true,
        terminal: true,
        reason: 'terminal',
        contentHash: hashText(answerText),
        latestAssistantTextLength: answerText.length,
    };
};
