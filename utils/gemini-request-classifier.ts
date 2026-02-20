export const isGeminiGenerationEndpoint = (url: string): boolean => {
    return /\/_\/BardChatUi\/data\/assistant\.lamda\.BardFrontendService\/StreamGenerate/i.test(url);
};

export const shouldEmitGeminiLifecycle = (url: string): boolean => {
    return isGeminiGenerationEndpoint(url);
};

export const shouldEmitGeminiCompletion = (url: string): boolean => {
    return isGeminiGenerationEndpoint(url);
};
