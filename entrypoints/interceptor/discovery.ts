export function safePathname(url: string): string {
    try {
        const fallbackOrigin =
            typeof window !== 'undefined' && typeof window.location?.origin === 'string'
                ? window.location.origin
                : 'https://blackiya.local';
        return new URL(url, fallbackOrigin).pathname;
    } catch {
        return url.slice(0, 120);
    }
}

export function detectPlatformFromHostname(hostname = window.location.hostname): string {
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
}

export function isDiscoveryDiagnosticsEnabled(
    storage: Pick<Storage, 'getItem'> | null = (() => {
        try {
            return window.localStorage;
        } catch {
            return null;
        }
    })(),
): boolean {
    try {
        return storage?.getItem('blackiya.discovery') === '1';
    } catch {
        return false;
    }
}
