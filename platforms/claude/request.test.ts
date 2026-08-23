import { describe, expect, it } from 'bun:test';
import { CLAUDE_DETAIL_URL, SYNTHETIC_CONVERSATION_ID, SYNTHETIC_ORGANIZATION_ID } from './fixtures/conversation';
import {
    buildClaudeConversationRequest,
    isClaudeConversationDetailRequest,
    parseClaudeConversationApiUrl,
} from './request';

describe('Claude canonical detail request helpers', () => {
    it('should build the HAR-observed GET request with explicit organization context', () => {
        expect(
            buildClaudeConversationRequest(SYNTHETIC_CONVERSATION_ID, {
                organizationId: SYNTHETIC_ORGANIZATION_ID,
            }),
        ).toEqual({
            method: 'GET',
            url: CLAUDE_DETAIL_URL,
            requiresAuthContext: false,
        });
    });

    it('should parse organization and conversation context from a canonical detail URL', () => {
        expect(parseClaudeConversationApiUrl(CLAUDE_DETAIL_URL)).toEqual({
            organizationId: SYNTHETIC_ORGANIZATION_ID,
            conversationId: SYNTHETIC_CONVERSATION_ID,
        });
    });

    it('should reject invalid IDs and non-Claude detail URLs', () => {
        expect(buildClaudeConversationRequest('not-an-id', { organizationId: SYNTHETIC_ORGANIZATION_ID })).toBeNull();
        expect(buildClaudeConversationRequest(SYNTHETIC_CONVERSATION_ID, { organizationId: 'not-an-id' })).toBeNull();
        expect(parseClaudeConversationApiUrl(CLAUDE_DETAIL_URL.replace('claude.ai', 'example.com'))).toBeNull();
        expect(parseClaudeConversationApiUrl(`https://claude.ai/chat/${SYNTHETIC_CONVERSATION_ID}`)).toBeNull();
    });

    it('should reject detail URLs that weaken or omit canonical completeness parameters', () => {
        expect(parseClaudeConversationApiUrl(CLAUDE_DETAIL_URL.split('?')[0]!)).toBeNull();
        expect(
            parseClaudeConversationApiUrl(CLAUDE_DETAIL_URL.replace('render_all_tools=true', 'render_all_tools=false')),
        ).toBeNull();
        expect(parseClaudeConversationApiUrl(CLAUDE_DETAIL_URL.replace('tree=true', 'tree=false'))).toBeNull();
        expect(
            parseClaudeConversationApiUrl(CLAUDE_DETAIL_URL.replace('consistency=strong', 'consistency=eventual')),
        ).toBeNull();
        expect(parseClaudeConversationApiUrl(`${CLAUDE_DETAIL_URL}&include_unrelated=true`)).toBeNull();
    });

    it('should narrowly match only canonical GET detail responses for cache capture', () => {
        expect(isClaudeConversationDetailRequest(CLAUDE_DETAIL_URL, 'GET')).toBeTrue();
        expect(isClaudeConversationDetailRequest(CLAUDE_DETAIL_URL, 'get')).toBeTrue();
        expect(isClaudeConversationDetailRequest(CLAUDE_DETAIL_URL, 'POST')).toBeFalse();
        expect(
            isClaudeConversationDetailRequest(
                CLAUDE_DETAIL_URL.replace('render_all_tools=true', 'render_all_tools=false'),
                'GET',
            ),
        ).toBeFalse();
        expect(isClaudeConversationDetailRequest(`${CLAUDE_DETAIL_URL}&include_unrelated=true`, 'GET')).toBeFalse();
        expect(
            isClaudeConversationDetailRequest(
                `https://claude.ai/api/organizations/${SYNTHETIC_ORGANIZATION_ID}/projects?limit=30`,
                'GET',
            ),
        ).toBeFalse();
    });
});
