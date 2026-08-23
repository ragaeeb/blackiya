import { GROK_STREAM_CONVERSATION_ID_PATTERN } from './url-utils';

const X_GROK_OPERATION_ID = 'JfjvClaXup5BQFcwzcDUpA';
const X_GROK_OPERATION_NAME = 'GrokConversationItemsByRestId';

const X_GROK_FEATURES = {
    creator_subscriptions_tweet_preview_api_enabled: true,
    premium_content_api_read_enabled: false,
    communities_web_enable_tweet_community_results_fetch: true,
    c9s_tweet_anatomy_moderator_badge_enabled: true,
    responsive_web_grok_analyze_button_fetch_trends_enabled: false,
    responsive_web_grok_analyze_post_followups_enabled: true,
    rweb_cashtags_composer_attachment_enabled: true,
    responsive_web_jetfuel_frame: true,
    responsive_web_grok_share_attachment_enabled: true,
    responsive_web_grok_annotations_enabled: true,
    articles_preview_enabled: true,
    responsive_web_edit_tweet_api_enabled: true,
    rweb_conversational_replies_downvote_enabled: false,
    graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
    view_counts_everywhere_api_enabled: true,
    longform_notetweets_consumption_enabled: true,
    responsive_web_twitter_article_tweet_consumption_enabled: true,
    content_disclosure_indicator_enabled: true,
    content_disclosure_ai_generated_indicator_enabled: true,
    responsive_web_grok_show_grok_translated_post: true,
    responsive_web_grok_analysis_button_from_backend: true,
    post_ctas_fetch_enabled: false,
    rweb_cashtags_enabled: true,
    freedom_of_speech_not_reach_fetch_enabled: true,
    standardized_nudges_misinfo: true,
    tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
    longform_notetweets_rich_text_read_enabled: true,
    longform_notetweets_inline_media_enabled: false,
    profile_label_improvements_pcf_label_in_post_enabled: true,
    responsive_web_profile_redirect_enabled: true,
    rweb_tipjar_consumption_enabled: false,
    verified_phone_label_enabled: false,
    responsive_web_grok_image_annotation_enabled: true,
    responsive_web_grok_imagine_annotation_enabled: true,
    responsive_web_grok_community_note_auto_translation_is_enabled: true,
    responsive_web_graphql_timeline_navigation_enabled: true,
} as const;

const isXHost = (hostname: string) => hostname === 'x.com' || hostname === 'www.x.com';

export const isXGrokConversationItemsEndpoint = (url: string) => {
    try {
        const parsed = new URL(url);
        return isXHost(parsed.hostname) && parsed.pathname.endsWith(`/${X_GROK_OPERATION_NAME}`);
    } catch {
        return false;
    }
};

export const extractXGrokConversationId = (url: string): string | null => {
    try {
        const parsed = new URL(url);
        if (!isXHost(parsed.hostname)) {
            return null;
        }
        if (parsed.pathname === '/i/grok') {
            const pageId = parsed.searchParams.get('conversation');
            return pageId && GROK_STREAM_CONVERSATION_ID_PATTERN.test(pageId) ? pageId : null;
        }
        if (!isXGrokConversationItemsEndpoint(url)) {
            return null;
        }
        const variables = JSON.parse(parsed.searchParams.get('variables') ?? '{}') as { restId?: unknown };
        return typeof variables.restId === 'string' && GROK_STREAM_CONVERSATION_ID_PATTERN.test(variables.restId)
            ? variables.restId
            : null;
    } catch {
        return null;
    }
};

export const buildXGrokConversationItemsUrl = (conversationId: string): string => {
    if (!GROK_STREAM_CONVERSATION_ID_PATTERN.test(conversationId)) {
        return '';
    }
    const params = new URLSearchParams();
    params.set('variables', JSON.stringify({ restId: conversationId }));
    params.set('features', JSON.stringify(X_GROK_FEATURES));
    return `https://x.com/i/api/graphql/${X_GROK_OPERATION_ID}/${X_GROK_OPERATION_NAME}?${params.toString()}`;
};
