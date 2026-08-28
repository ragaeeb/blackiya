export const ZAI_HOST = 'chat.z.ai';
export const ZAI_ORIGIN = `https://${ZAI_HOST}`;

export const ZAI_CONVERSATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const isZaiConversationId = (value: unknown): value is string =>
    typeof value === 'string' && ZAI_CONVERSATION_ID_PATTERN.test(value);

export const buildZaiDetailUrl = (conversationId: string) => `${ZAI_ORIGIN}/api/v1/chats/${conversationId}`;

export const buildZaiMessagesBatchUrl = (conversationId: string) =>
    `${buildZaiDetailUrl(conversationId)}/messages/batch`;
