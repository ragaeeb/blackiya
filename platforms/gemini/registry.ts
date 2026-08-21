import { GEMINI_RPC_IDS } from '@/platforms/constants';

const parseGeminiUrl = (url: string) => {
    try {
        return new URL(url, 'https://gemini.google.com');
    } catch {
        return null;
    }
};

export const isGeminiTitlesEndpointUrl = (url: string): boolean => {
    const parsed = parseGeminiUrl(url);
    if (parsed) {
        if (!parsed.pathname.toLowerCase().includes('/_/bardchatui/data/batchexecute')) {
            return false;
        }
        const rpcids = parsed.searchParams.get('rpcids');
        return typeof rpcids === 'string' && rpcids.toLowerCase() === GEMINI_RPC_IDS.TITLES.toLowerCase();
    }
    return (
        /\/_\/BardChatUi\/data\/batchexecute/i.test(url) &&
        new RegExp(`(?:^|[?&])rpcids=${GEMINI_RPC_IDS.TITLES}(?:&|$)`, 'i').test(url)
    );
};
