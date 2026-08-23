import { describe, expect, it } from 'bun:test';

import { NOVA_CONVERSATION_ID } from './fixtures/conversation';
import { novaAdapter } from './index';

describe('Amazon Nova adapter', () => {
    it('should recognize only the canonical Nova origin', () => {
        expect(novaAdapter.isPlatformUrl(`https://nova.amazon.com/conversation/${NOVA_CONVERSATION_ID}`)).toBeTrue();
        expect(novaAdapter.isPlatformUrl('https://nova.amazon.com/')).toBeTrue();
        expect(novaAdapter.isPlatformUrl('http://nova.amazon.com/')).toBeFalse();
        expect(novaAdapter.isPlatformUrl('https://nova.amazon.com.evil.invalid/')).toBeFalse();
        expect(novaAdapter.isPlatformUrl('not-a-url')).toBeFalse();
    });

    it('should extract a UUID from canonical conversation URLs', () => {
        expect(
            novaAdapter.extractConversationId(
                `https://nova.amazon.com/conversation/${NOVA_CONVERSATION_ID}?synthetic=true`,
            ),
        ).toBe(NOVA_CONVERSATION_ID);
        expect(novaAdapter.extractConversationId(`https://nova.amazon.com/conversation/${NOVA_CONVERSATION_ID}/`)).toBe(
            NOVA_CONVERSATION_ID,
        );
    });

    it('should reject non-conversation, malformed, and cross-origin IDs', () => {
        expect(novaAdapter.extractConversationId('https://nova.amazon.com/')).toBeNull();
        expect(novaAdapter.extractConversationId('https://nova.amazon.com/conversation/not-a-uuid')).toBeNull();
        expect(
            novaAdapter.extractConversationId(`https://example.invalid/conversation/${NOVA_CONVERSATION_ID}`),
        ).toBeNull();
    });

    it('should format a bounded sanitized filename', () => {
        const filename = novaAdapter.formatFilename({
            title: 'Synthetic / Nova : Conversation',
            create_time: 1_777_777_700,
            update_time: 1_777_777_777,
            conversation_id: NOVA_CONVERSATION_ID,
            current_node: 'assistant-1',
            mapping: {},
            moderation_results: [],
            plugin_ids: null,
            gizmo_id: null,
            gizmo_type: null,
            is_archived: false,
            default_model_slug: 'amazon.nova.synthetic-v1:0',
            safe_urls: [],
            blocked_urls: [],
        });

        expect(filename.startsWith('Synthetic_Nova_Conversation_')).toBeTrue();
        expect(filename).not.toContain('/');
        expect(filename).not.toContain(':');
    });
});
