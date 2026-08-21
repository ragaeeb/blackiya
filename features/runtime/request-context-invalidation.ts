import { resolveTokenValidationFailureReason, stampToken } from '@/utils/protocol/session-token';

export const REQUEST_CONTEXT_INVALIDATION_MESSAGE = 'BLACKIYA_REQUEST_CONTEXT_INVALIDATION';

const INVALIDATABLE_PLATFORM_NAMES = ['ChatGPT', 'Gemini', 'Grok'] as const;

export type RequestContextInvalidationPlatform = (typeof INVALIDATABLE_PLATFORM_NAMES)[number];

export type RequestContextInvalidationMessage = {
    type: typeof REQUEST_CONTEXT_INVALIDATION_MESSAGE;
    platformName: RequestContextInvalidationPlatform;
    __blackiyaToken?: string;
};

const isInvalidatablePlatform = (value: unknown): value is RequestContextInvalidationPlatform => {
    return (
        typeof value === 'string' &&
        (INVALIDATABLE_PLATFORM_NAMES as readonly string[]).includes(value)
    );
};

export const isRequestContextInvalidationMessage = (
    value: unknown,
): value is RequestContextInvalidationMessage => {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const typed = value as Partial<RequestContextInvalidationMessage>;
    return typed.type === REQUEST_CONTEXT_INVALIDATION_MESSAGE && isInvalidatablePlatform(typed.platformName);
};

export const invalidateRequestContextInMainWorld = (platformName: string): void => {
    if (typeof window === 'undefined' || !isInvalidatablePlatform(platformName)) {
        return;
    }
    const message: RequestContextInvalidationMessage = {
        type: REQUEST_CONTEXT_INVALIDATION_MESSAGE,
        platformName,
    };
    window.postMessage(stampToken(message), window.location.origin);
};

export const isValidRequestContextInvalidationMessage = (message: unknown): boolean => {
    return isRequestContextInvalidationMessage(message) && resolveTokenValidationFailureReason(message) === null;
};
