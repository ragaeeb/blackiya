import { describe, expect, it } from 'bun:test';
import sampleConversation from '@/data/chatgpt/sample_chatgpt_conversation.json';
import type { ConversationData, MessageNode } from '@/utils/types';

describe('Conversation types fixture contract', () => {
    const conversation = sampleConversation as ConversationData;

    it('has required top-level fields with expected basic types', () => {
        expect(typeof conversation.title).toBe('string');
        expect(typeof conversation.conversation_id).toBe('string');
        expect(typeof conversation.current_node).toBe('string');
        expect(typeof conversation.create_time).toBe('number');
        expect(typeof conversation.update_time).toBe('number');
        expect(typeof conversation.mapping).toBe('object');
        expect(Object.keys(conversation.mapping).length).toBeGreaterThan(0);
    });

    it('references a valid current node and exactly one root node', () => {
        expect(conversation.mapping[conversation.current_node]).toBeDefined();
        const rootNodes = Object.values(conversation.mapping).filter((node) => (node as MessageNode).parent === null);
        expect(rootNodes.length).toBe(1);
    });

    it('maintains parent/child tree consistency for all mapped nodes', () => {
        for (const node of Object.values(conversation.mapping)) {
            const messageNode = node as MessageNode;
            expect(Array.isArray(messageNode.children)).toBeTrue();
            if (messageNode.parent !== null) {
                expect(conversation.mapping[messageNode.parent]).toBeDefined();
            }
            for (const childId of messageNode.children) {
                const child = conversation.mapping[childId] as MessageNode | undefined;
                expect(child).toBeDefined();
                expect(child?.parent).toBe(messageNode.id);
            }
        }
    });

    it('contains both user and assistant authored messages', () => {
        const roles = new Set<string>();
        for (const node of Object.values(conversation.mapping)) {
            const role = (node as MessageNode).message?.author?.role;
            if (role) {
                roles.add(role);
            }
        }
        expect(roles.has('user')).toBeTrue();
        expect(roles.has('assistant')).toBeTrue();
    });
});
