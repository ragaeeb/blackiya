export function isGeminiGenerationEndpoint(url: string): boolean {
    return /\/_\/BardChatUi\/data\/assistant\.lamda\.BardFrontendService\/StreamGenerate/i.test(url);
}

export function shouldEmitGeminiLifecycle(url: string): boolean {
    return isGeminiGenerationEndpoint(url);
}

export function shouldEmitGeminiCompletion(url: string): boolean {
    return isGeminiGenerationEndpoint(url);
}
