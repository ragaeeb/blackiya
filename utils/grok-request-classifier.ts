function getNormalizedPath(url: string): string {
    try {
        return new URL(url).pathname.toLowerCase();
    } catch {
        return url.toLowerCase();
    }
}

export function isGrokGenerationEndpoint(url: string): boolean {
    const path = getNormalizedPath(url);
    return path.includes('/rest/app-chat/conversations/new') || path.includes('/2/grok/add_response.json');
}

export function isGrokCompletionCandidateEndpoint(url: string): boolean {
    const path = getNormalizedPath(url);
    if (path.includes('/rest/app-chat/conversations/new')) {
        return false;
    }
    if (path.includes('/rest/app-chat/conversations/reconnect-response-v2/')) {
        return false;
    }
    return (
        path.includes('/rest/app-chat/conversations/') &&
        (path.includes('/load-responses') || path.includes('/response-node'))
    );
}

export function shouldEmitGrokLifecycle(url: string): boolean {
    return isGrokGenerationEndpoint(url);
}

export function shouldEmitGrokCompletion(url: string): boolean {
    return isGrokCompletionCandidateEndpoint(url);
}
