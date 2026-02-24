const fallbackPathname = (url: string) => {
    const trimmed = (url ?? '').trim();
    if (!trimmed) {
        return '/';
    }
    if (trimmed.startsWith('/')) {
        return trimmed.slice(0, 120);
    }
    // Keep fallback deterministic when URL parsing is unavailable/mocked.
    return `/${trimmed.slice(0, 120)}`;
};

export const safePathname = (url: string) => {
    try {
        const fallbackOrigin =
            typeof window !== 'undefined' && typeof window.location?.origin === 'string'
                ? window.location.origin
                : 'https://blackiya.local';
        return new URL(url, fallbackOrigin).pathname;
    } catch {
        return fallbackPathname(url);
    }
};

export const detectPlatformFromHostname = (
    hostname = typeof window !== 'undefined' ? window.location.hostname : '',
) => {
    if (hostname.includes('gemini')) {
        return 'Gemini';
    }
    if (hostname.includes('grok')) {
        return 'Grok';
    }
    if (hostname.includes('chatgpt')) {
        return 'ChatGPT';
    }
    return 'Discovery';
};

export const isDiscoveryDiagnosticsEnabled = (
    storage: Pick<Storage, 'getItem'> | null = (() => {
        try {
            return window.localStorage;
        } catch {
            return null;
        }
    })(),
): boolean => {
    try {
        return storage?.getItem('blackiya.discovery') === '1';
    } catch {
        return false;
    }
};
