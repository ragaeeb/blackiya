import { isGeminiGenerationEndpointUrl } from '@/platforms/gemini/registry';

export const isGeminiGenerationEndpoint = (url: string): boolean => {
    return isGeminiGenerationEndpointUrl(url);
};

export const shouldEmitGeminiLifecycle = (url: string): boolean => {
    return isGeminiGenerationEndpoint(url);
};

export const shouldEmitGeminiCompletion = (url: string): boolean => {
    return isGeminiGenerationEndpoint(url);
};
