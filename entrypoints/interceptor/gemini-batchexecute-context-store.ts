import type { GeminiBatchexecuteContext } from '@/utils/gemini-batchexecute-bridge';

let context: GeminiBatchexecuteContext | null = null;
export const GEMINI_BATCHEXECUTE_CONTEXT_MAX_AGE_MS = 5 * 60 * 1_000;

const GEMINI_BATCHEXECUTE_PATH = '/_/bardchatui/data/batchexecute';

const parseRequestUrl = (url: string): URL | null => {
    try {
        return new URL(url, 'https://gemini.google.com');
    } catch {
        return null;
    }
};

const asBodyString = (body: unknown): string | null => {
    if (typeof body === 'string') {
        return body;
    }
    if (body instanceof URLSearchParams) {
        return body.toString();
    }
    return null;
};

const readOptionalNumber = (value: string | null): number | undefined => {
    if (!value) {
        return undefined;
    }
    const numeric = Number.parseInt(value, 10);
    return Number.isFinite(numeric) ? numeric : undefined;
};

const readOptionalString = (value: string | null): string | undefined => {
    if (!value) {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
};

const isGeminiBatchexecuteUrl = (parsed: URL) => parsed.pathname.toLowerCase().includes(GEMINI_BATCHEXECUTE_PATH);

export const maybeCaptureGeminiBatchexecuteContext = (url: string, body: unknown, now = Date.now()) => {
    const parsed = parseRequestUrl(url);
    if (!parsed || !isGeminiBatchexecuteUrl(parsed)) {
        return;
    }

    const bodyString = asBodyString(body);
    const bodyParams = bodyString ? new URLSearchParams(bodyString) : null;
    const next: GeminiBatchexecuteContext = {
        bl: readOptionalString(parsed.searchParams.get('bl')),
        fSid: readOptionalString(parsed.searchParams.get('f.sid')),
        hl: readOptionalString(parsed.searchParams.get('hl')),
        rt: readOptionalString(parsed.searchParams.get('rt')),
        reqid: readOptionalNumber(parsed.searchParams.get('_reqid')),
        at: readOptionalString(bodyParams?.get('at') ?? null),
        updatedAt: now,
    };

    context = next;
};

export const getGeminiBatchexecuteContext = (now = Date.now()): GeminiBatchexecuteContext | undefined => {
    if (!context) {
        return undefined;
    }
    if (now - context.updatedAt >= GEMINI_BATCHEXECUTE_CONTEXT_MAX_AGE_MS) {
        context = null;
        return undefined;
    }
    return { ...context };
};

export const resetGeminiBatchexecuteContext = () => {
    context = null;
};
