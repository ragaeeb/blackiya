import { describe, expect, it } from 'bun:test';
import { NOVA_CONVERSATION_DETAIL_TARGET } from './constants';
import { NOVA_CONVERSATION_ID } from './fixtures/conversation';
import { buildNovaConversationRequest, isNovaConversationDetailRequest } from './request';

const capturedContext = {
    conversationId: NOVA_CONVERSATION_ID,
    traceId: 'synthetic-trace-id',
    userType: 'synthetic-user-type',
    antiCsrfTokenA2z: '[ephemeral]',
    amzContentSha256: '[ephemeral]',
    amzDate: '[ephemeral]',
    amzSecurityToken: '[ephemeral]',
    amzSessionId: '[ephemeral]',
    sdkInvocationId: '33333333-3333-4333-8333-333333333333',
    sdkRequest: 'attempt=1; max=3',
};

describe('Amazon Nova detail request helpers', () => {
    it('should narrowly recognize the canonical detail target on POST /api', () => {
        expect(
            isNovaConversationDetailRequest({
                url: 'https://nova.amazon.com/api',
                method: 'POST',
                target: NOVA_CONVERSATION_DETAIL_TARGET,
            }),
        ).toBeTrue();
        expect(
            isNovaConversationDetailRequest({
                url: 'https://nova.amazon.com/api',
                method: 'POST',
                target: 'HyperionWebsiteService.StartSession',
            }),
        ).toBeFalse();
        expect(
            isNovaConversationDetailRequest({
                url: 'https://nova.amazon.com/api?operation=synthetic',
                method: 'POST',
                target: NOVA_CONVERSATION_DETAIL_TARGET,
            }),
        ).toBeFalse();
        expect(
            isNovaConversationDetailRequest({
                url: 'https://nova.amazon.com/registry',
                method: 'POST',
                target: NOVA_CONVERSATION_DETAIL_TARGET,
            }),
        ).toBeFalse();
        expect(
            isNovaConversationDetailRequest({
                url: 'https://nova.amazon.com/api',
                method: 'GET',
                target: NOVA_CONVERSATION_DETAIL_TARGET,
            }),
        ).toBeFalse();
    });

    it('should reconstruct the captured request method, body shape, target, and ephemeral context', () => {
        const request = buildNovaConversationRequest(NOVA_CONVERSATION_ID, capturedContext);

        expect(request).not.toBeNull();
        expect(request?.url).toBe('https://nova.amazon.com/api');
        expect(request?.method).toBe('POST');
        expect(request?.headers['content-type']).toBe('application/x-amz-json-1.0');
        expect(request?.headers['x-amz-target']).toBe(NOVA_CONVERSATION_DETAIL_TARGET);
        expect(request?.headers['anti-csrftoken-a2z']).toBe('[ephemeral]');
        expect(JSON.parse(request?.body ?? '{}')).toEqual({
            conversationId: NOVA_CONVERSATION_ID,
            userType: 'synthetic-user-type',
            traceId: 'synthetic-trace-id',
        });
    });

    it('should reject malformed IDs and incomplete request context', () => {
        expect(buildNovaConversationRequest('not-a-uuid', capturedContext)).toBeNull();
        expect(buildNovaConversationRequest('22222222-2222-4222-8222-222222222222', capturedContext)).toBeNull();
        expect(
            buildNovaConversationRequest(NOVA_CONVERSATION_ID, { ...capturedContext, amzSecurityToken: '' }),
        ).toBeNull();
    });
});
