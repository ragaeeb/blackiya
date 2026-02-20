export const BLACKIYA_PUBLIC_API_VERSION = '2.2.1';
export const BLACKIYA_WAIT_FOR_READY_TIMEOUT_MS = 15_000;

export const BRIDGE_ERROR_CODES = {
    TIMEOUT: 'TIMEOUT',
    REQUEST_FAILED: 'REQUEST_FAILED',
    NOT_FOUND: 'NOT_FOUND',
} as const;

export type BridgeErrorCode = (typeof BRIDGE_ERROR_CODES)[keyof typeof BRIDGE_ERROR_CODES];
