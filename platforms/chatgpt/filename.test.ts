/**
 * ChatGPT formatFilename tests
 *
 * Covers title sanitization, placeholder fallbacks, length truncation,
 * and timestamp inclusion.
 */

import { beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('@/utils/logger', () => ({
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, setLevel: () => {} },
}));

const VALID_ID = '696bc3d5-fa84-8328-b209-4d65cb229e59';

const baseData = (overrides: any = {}) => ({
    title: 'Test Conversation',
    create_time: 1768670166.492617,
    update_time: 1768671022.523312,
    mapping: {},
    conversation_id: VALID_ID,
    current_node: 'node-1',
    moderation_results: [],
    plugin_ids: null,
    gizmo_id: null,
    gizmo_type: null,
    is_archived: false,
    default_model_slug: 'gpt-4',
    safe_urls: [],
    blocked_urls: [],
    ...overrides,
});

const userNode = (content: string) => ({
    root: { id: 'root', message: null, parent: null, children: ['u1'] },
    u1: {
        id: 'u1',
        parent: 'root',
        children: [],
        message: {
            id: 'u1',
            author: { role: 'user', name: null, metadata: {} },
            create_time: 1768670166.492617,
            update_time: 1768670166.492617,
            content: { content_type: 'text', parts: [content] },
            status: 'finished_successfully',
            end_turn: true,
            weight: 1,
            metadata: {},
            recipient: 'all',
            channel: null,
        },
    },
});

describe('ChatGPT formatFilename', () => {
    let adapter: any;

    beforeAll(async () => {
        const module = await import('@/platforms/chatgpt');
        adapter = module.createChatGPTAdapter();
    });

    it('should include sanitized title and a date-like timestamp', () => {
        const filename = adapter.formatFilename(baseData());
        expect(filename).toContain('Test_Conversation');
        expect(filename).toMatch(/\d{4}-\d{2}-\d{2}/);
    });

    it('should sanitize special characters in title', () => {
        const filename = adapter.formatFilename(baseData({ title: 'Test: Special/Characters\\Here?' }));
        expect(filename).not.toMatch(/[:/\\?<>"|*]/);
    });

    it('should fall back to conversation_id prefix when title is empty and mapping has no user messages', () => {
        const filename = adapter.formatFilename(baseData({ title: '' }));
        expect(filename).toContain('conversation');
    });

    it('should derive title from first user message when title is empty', () => {
        const filename = adapter.formatFilename(
            baseData({ title: '', mapping: userNode('Total Sahabah Estimates and source ranges'), current_node: 'u1' }),
        );
        expect(filename).toContain('Total_Sahabah_Estimates_and_source_ranges');
        expect(filename).not.toContain('conversation_696bc3d5');
    });

    it('should derive title from first user message when title is placeholder "New chat"', () => {
        const filename = adapter.formatFilename(
            baseData({
                title: 'New chat',
                mapping: userNode('Digital Eye Strain Relief tips and habits'),
                current_node: 'u1',
            }),
        );
        expect(filename).toContain('Digital_Eye_Strain_Relief_tips_and_habits');
        expect(filename).not.toContain('New_chat');
    });

    it('should truncate very long titles so the overall filename stays under 150 chars', () => {
        const filename = adapter.formatFilename(baseData({ title: 'A'.repeat(200) }));
        expect(filename.length).toBeLessThan(150);
    });

    it('should truncate a long derived first-user-message title with an ellipsis', () => {
        const longPrompt = `This is an intentionally long prompt ${'x'.repeat(140)}`;
        const filename = adapter.formatFilename(
            baseData({ title: 'New chat', mapping: userNode(longPrompt), current_node: 'u1' }),
        );
        expect(filename).toContain('...');
    });
});
