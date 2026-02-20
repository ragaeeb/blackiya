import {
    isGrokCompletionCandidateEndpointUrl,
    isGrokGenerationEndpointUrl,
    isGrokStreamingEndpointUrl,
} from '@/platforms/grok/registry';

export const isGrokGenerationEndpoint = (url: string): boolean => {
    return isGrokGenerationEndpointUrl(url);
};

export const isGrokStreamingEndpoint = (url: string): boolean => {
    return isGrokStreamingEndpointUrl(url);
};

export const isGrokCompletionCandidateEndpoint = (url: string): boolean => {
    return isGrokCompletionCandidateEndpointUrl(url);
};

export const shouldEmitGrokLifecycle = (url: string): boolean => {
    return isGrokGenerationEndpoint(url);
};

export const shouldEmitGrokCompletion = (url: string): boolean => {
    return isGrokCompletionCandidateEndpoint(url);
};
