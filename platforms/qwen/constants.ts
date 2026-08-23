export const QWEN_HOST = 'chat.qwen.ai';
export const QWEN_ORIGIN = `https://${QWEN_HOST}`;
export const QWEN_CONVERSATION_ID_PATTERN =
    /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export const QWEN_DETAIL_HISTORY_LIMIT = 10;
export const QWEN_REQUEST_CONTEXT_HEADER_NAMES = [
    'bx-umidtoken',
    'bx-ua',
    'bx-v',
    'source',
    'timezone',
    'version',
] as const;
