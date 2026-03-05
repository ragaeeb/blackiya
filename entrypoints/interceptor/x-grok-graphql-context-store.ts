import type { XGrokGraphqlContext } from '@/utils/x-grok-graphql-bridge';

let context: XGrokGraphqlContext | null = null;

const X_GROK_DETAIL_PATH_PATTERN = /\/i\/api\/graphql\/([^/]+)\/GrokConversationItemsByRestId$/;

const parseRequestUrl = (url: string): URL | null => {
    try {
        return new URL(url, 'https://x.com');
    } catch {
        return null;
    }
};

const readOptionalString = (value: string | null): string | undefined => {
    if (!value) {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
};

export const maybeCaptureXGrokGraphqlContext = (url: string) => {
    const parsed = parseRequestUrl(url);
    if (!parsed) {
        return;
    }
    const pathMatch = parsed.pathname.match(X_GROK_DETAIL_PATH_PATTERN);
    if (!pathMatch) {
        return;
    }

    const queryId = readOptionalString(pathMatch[1]);
    if (!queryId) {
        return;
    }

    context = {
        queryId,
        features: readOptionalString(parsed.searchParams.get('features')) ?? context?.features,
        fieldToggles: readOptionalString(parsed.searchParams.get('fieldToggles')) ?? context?.fieldToggles,
        updatedAt: Date.now(),
    };
};

export const getXGrokGraphqlContext = (): XGrokGraphqlContext | undefined => {
    if (!context) {
        return undefined;
    }
    return { ...context };
};

export const resetXGrokGraphqlContext = () => {
    context = null;
};
