export type StreamDebugPlatform = 'ChatGPT' | 'Gemini' | 'Grok' | 'Qwen';

export type GenerationEndpoint = {
    platform: StreamDebugPlatform;
    endpoint: `${Lowercase<StreamDebugPlatform>}-generation`;
    path: string;
};

const endpointRules: Array<{
    platform: StreamDebugPlatform;
    endpoint: GenerationEndpoint['endpoint'];
    origins: ReadonlySet<string>;
    matches: (path: string) => boolean;
}> = [
    {
        platform: 'ChatGPT',
        endpoint: 'chatgpt-generation',
        origins: new Set(['https://chatgpt.com', 'https://chat.openai.com']),
        matches: (path) => /^\/backend-api\/f\/conversation\/?$/i.test(path),
    },
    {
        platform: 'Gemini',
        endpoint: 'gemini-generation',
        origins: new Set(['https://gemini.google.com']),
        matches: (path) =>
            /^\/_\/bardchatui\/data\/assistant\.lamda\.bardfrontendservice\/streamgenerate\/?$/i.test(path),
    },
    {
        platform: 'Grok',
        endpoint: 'grok-generation',
        origins: new Set(['https://grok.x.com', 'https://x.com', 'https://www.x.com']),
        matches: (path) => /^\/2\/grok\/add_response\.json\/?$/i.test(path),
    },
    {
        platform: 'Grok',
        endpoint: 'grok-generation',
        origins: new Set(['https://grok.com', 'https://www.grok.com']),
        matches: (path) => /^\/rest\/app-chat\/conversations\/new\/?$/i.test(path),
    },
    {
        platform: 'Qwen',
        endpoint: 'qwen-generation',
        origins: new Set(['https://chat.qwen.ai']),
        matches: (path) => /^\/api\/v2\/chat\/completions\/?$/i.test(path),
    },
];

const parseRequestUrl = (url: string, pageUrl?: string): URL | null => {
    try {
        const parsed = pageUrl ? new URL(url, pageUrl) : new URL(url);
        return parsed.protocol === 'https:' ? parsed : null;
    } catch {
        return null;
    }
};

export const classifyGenerationEndpoint = (
    url: string,
    method: string,
    pageUrl?: string,
): GenerationEndpoint | null => {
    if (method.toUpperCase() !== 'POST') {
        return null;
    }
    const parsed = parseRequestUrl(url, pageUrl);
    if (!parsed) {
        return null;
    }
    const path = parsed.pathname || '/';
    const rule = endpointRules.find((candidate) => candidate.origins.has(parsed.origin) && candidate.matches(path));
    return rule ? { platform: rule.platform, endpoint: rule.endpoint, path } : null;
};
