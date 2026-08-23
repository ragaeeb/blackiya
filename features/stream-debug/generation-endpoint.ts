export type StreamDebugPlatform = 'ChatGPT' | 'Gemini' | 'Grok' | 'Qwen';

export type GenerationEndpoint = {
    platform: StreamDebugPlatform;
    endpoint: `${Lowercase<StreamDebugPlatform>}-generation`;
    path: string;
};

const endpointRules: Array<{
    platform: StreamDebugPlatform;
    endpoint: GenerationEndpoint['endpoint'];
    matches: (path: string) => boolean;
}> = [
    {
        platform: 'ChatGPT',
        endpoint: 'chatgpt-generation',
        matches: (path) => /^\/backend-api\/f\/conversation\/?$/i.test(path),
    },
    {
        platform: 'Gemini',
        endpoint: 'gemini-generation',
        matches: (path) =>
            /^\/_\/bardchatui\/data\/assistant\.lamda\.bardfrontendservice\/streamgenerate\/?$/i.test(path),
    },
    {
        platform: 'Grok',
        endpoint: 'grok-generation',
        matches: (path) =>
            /^\/2\/grok\/add_response\.json\/?$/i.test(path) || /^\/rest\/app-chat\/conversations\/new\/?$/i.test(path),
    },
    {
        platform: 'Qwen',
        endpoint: 'qwen-generation',
        matches: (path) => /^\/api\/v2\/chat\/completions\/?$/i.test(path),
    },
];

const pathname = (url: string): string => {
    try {
        return new URL(url, 'https://blackiya.invalid').pathname || '/';
    } catch {
        return url.split(/[?#]/, 1)[0] || '/';
    }
};

export const classifyGenerationEndpoint = (url: string, method: string): GenerationEndpoint | null => {
    if (method.toUpperCase() !== 'POST') {
        return null;
    }
    const path = pathname(url);
    const rule = endpointRules.find((candidate) => candidate.matches(path));
    return rule ? { platform: rule.platform, endpoint: rule.endpoint, path } : null;
};
