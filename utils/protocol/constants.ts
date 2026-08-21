export const MESSAGE_TYPES = {
    SESSION_INIT: 'BLACKIYA_SESSION_INIT',
} as const;

export type MessageType = (typeof MESSAGE_TYPES)[keyof typeof MESSAGE_TYPES];
