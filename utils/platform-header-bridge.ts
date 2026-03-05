import type { HeaderRecord } from '@/utils/proactive-fetch-headers';

export const PLATFORM_HEADERS_REQUEST_MESSAGE = 'BLACKIYA_PLATFORM_HEADERS_REQUEST';
export const PLATFORM_HEADERS_RESPONSE_MESSAGE = 'BLACKIYA_PLATFORM_HEADERS_RESPONSE';

export type PlatformHeadersRequestMessage = {
    type: typeof PLATFORM_HEADERS_REQUEST_MESSAGE;
    requestId: string;
    platformName: string;
    __blackiyaToken?: string;
};

export type PlatformHeadersResponseMessage = {
    type: typeof PLATFORM_HEADERS_RESPONSE_MESSAGE;
    requestId: string;
    platformName: string;
    headers?: HeaderRecord;
    __blackiyaToken?: string;
};

export const isPlatformHeadersRequestMessage = (value: unknown): value is PlatformHeadersRequestMessage => {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const typed = value as Partial<PlatformHeadersRequestMessage>;
    return (
        typed.type === PLATFORM_HEADERS_REQUEST_MESSAGE &&
        typeof typed.requestId === 'string' &&
        typed.requestId.length > 0 &&
        typeof typed.platformName === 'string' &&
        typed.platformName.length > 0
    );
};

export const isPlatformHeadersResponseMessage = (value: unknown): value is PlatformHeadersResponseMessage => {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const typed = value as Partial<PlatformHeadersResponseMessage>;
    return (
        typed.type === PLATFORM_HEADERS_RESPONSE_MESSAGE &&
        typeof typed.requestId === 'string' &&
        typed.requestId.length > 0 &&
        typeof typed.platformName === 'string' &&
        typed.platformName.length > 0
    );
};
