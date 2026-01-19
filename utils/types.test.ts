/**
 * Tests for ChatGPT Conversation Data Parsing
 *
 * TDD tests for parsing real ChatGPT API response data
 */

import { describe, expect, it } from 'bun:test';
import sampleConversation from '@/data/chatgpt/sample_chatgpt_conversation.json';
import type { ConversationData, MessageNode } from '@/utils/types';

describe('ChatGPT Conversation Data Parsing', () => {
    // Type assertion to verify the sample data matches our types
    const conversation = sampleConversation as ConversationData;

    describe('top-level fields', () => {
        it('should have a title string', () => {
            expect(typeof conversation.title).toBe('string');
            expect(conversation.title).toBe('Sample Conversation');
        });

        it('should have create_time and update_time as numbers', () => {
            expect(typeof conversation.create_time).toBe('number');
            expect(typeof conversation.update_time).toBe('number');
            expect(conversation.create_time).toBeGreaterThan(0);
            expect(conversation.update_time).toBeGreaterThanOrEqual(conversation.create_time);
        });

        it('should have a valid conversation_id', () => {
            expect(typeof conversation.conversation_id).toBe('string');
            expect(conversation.conversation_id).toMatch(
                /^[a-f0-9]{8}-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{12}$/,
            );
        });

        it('should have a current_node pointing to a valid node', () => {
            expect(typeof conversation.current_node).toBe('string');
            expect(conversation.mapping[conversation.current_node]).toBeDefined();
        });

        it('should have a mapping object with message nodes', () => {
            expect(typeof conversation.mapping).toBe('object');
            expect(Object.keys(conversation.mapping).length).toBeGreaterThan(0);
        });
    });

    describe('message node structure', () => {
        it('should have valid message nodes with required fields', () => {
            for (const [nodeId, node] of Object.entries(conversation.mapping)) {
                const messageNode = node as MessageNode;

                expect(messageNode.id).toBe(nodeId);
                expect(Array.isArray(messageNode.children)).toBe(true);

                // parent can be null for root node
                if (messageNode.parent !== null) {
                    expect(typeof messageNode.parent).toBe('string');
                    // Parent should exist in mapping
                    expect(conversation.mapping[messageNode.parent]).toBeDefined();
                }
            }
        });

        it('should have messages with author roles', () => {
            const nodesWithMessages = Object.values(conversation.mapping).filter(
                (node) => (node as MessageNode).message !== null,
            );

            expect(nodesWithMessages.length).toBeGreaterThan(0);

            for (const node of nodesWithMessages) {
                const messageNode = node as MessageNode;
                const message = messageNode.message!;

                expect(['system', 'user', 'assistant', 'tool']).toContain(message.author.role);
            }
        });

        it('should have user and assistant messages', () => {
            const roles = new Set<string>();

            for (const node of Object.values(conversation.mapping)) {
                const messageNode = node as MessageNode;
                if (messageNode.message?.author?.role) {
                    roles.add(messageNode.message.author.role);
                }
            }

            expect(roles.has('user')).toBe(true);
            expect(roles.has('assistant')).toBe(true);
        });

        it('should have message content with content_type', () => {
            const nodesWithMessages = Object.values(conversation.mapping).filter(
                (node) => (node as MessageNode).message !== null,
            );

            for (const node of nodesWithMessages) {
                const messageNode = node as MessageNode;
                const message = messageNode.message!;

                expect(typeof message.content.content_type).toBe('string');
                expect(['text', 'thoughts', 'reasoning_recap', 'code', 'execution_output']).toContain(
                    message.content.content_type,
                );
            }
        });
    });

    describe('message tree structure', () => {
        it('should have a root node with no parent', () => {
            const rootNodes = Object.values(conversation.mapping).filter(
                (node) => (node as MessageNode).parent === null,
            );

            expect(rootNodes.length).toBe(1);
        });

        it('should form a valid tree structure (children reference valid nodes)', () => {
            for (const node of Object.values(conversation.mapping)) {
                const messageNode = node as MessageNode;

                for (const childId of messageNode.children) {
                    expect(conversation.mapping[childId]).toBeDefined();
                    expect((conversation.mapping[childId] as MessageNode).parent).toBe(messageNode.id);
                }
            }
        });

        it('should have current_node as a leaf or valid node in the tree', () => {
            const currentNode = conversation.mapping[conversation.current_node] as MessageNode;
            expect(currentNode).toBeDefined();
            // Current node should be reachable from root
        });
    });

    describe('optional fields', () => {
        it('should handle optional fields correctly', () => {
            // These fields can be null or have values
            expect(conversation.plugin_ids === null || Array.isArray(conversation.plugin_ids)).toBe(true);
            expect(conversation.gizmo_id === null || typeof conversation.gizmo_id === 'string').toBe(true);
            expect(typeof conversation.is_archived).toBe('boolean');
            expect(Array.isArray(conversation.safe_urls)).toBe(true);
            expect(Array.isArray(conversation.blocked_urls)).toBe(true);
        });
    });

    describe('content types', () => {
        it('should have text content with parts array', () => {
            const textNodes = Object.values(conversation.mapping).filter((node) => {
                const messageNode = node as MessageNode;
                return messageNode.message?.content?.content_type === 'text';
            });

            expect(textNodes.length).toBeGreaterThan(0);

            for (const node of textNodes) {
                const messageNode = node as MessageNode;
                expect(Array.isArray(messageNode.message!.content.parts)).toBe(true);
            }
        });

        it('should have thoughts content with thoughts array', () => {
            const thoughtNodes = Object.values(conversation.mapping).filter((node) => {
                const messageNode = node as MessageNode;
                return messageNode.message?.content?.content_type === 'thoughts';
            });

            expect(thoughtNodes.length).toBeGreaterThan(0);

            for (const node of thoughtNodes) {
                const messageNode = node as MessageNode;
                expect(Array.isArray(messageNode.message!.content.thoughts)).toBe(true);

                for (const thought of messageNode.message!.content.thoughts!) {
                    expect(typeof thought.summary).toBe('string');
                    expect(typeof thought.content).toBe('string');
                    expect(Array.isArray(thought.chunks)).toBe(true);
                    expect(typeof thought.finished).toBe('boolean');
                }
            }
        });

        it('should have reasoning_recap content', () => {
            const recapNodes = Object.values(conversation.mapping).filter((node) => {
                const messageNode = node as MessageNode;
                return messageNode.message?.content?.content_type === 'reasoning_recap';
            });

            expect(recapNodes.length).toBeGreaterThan(0);

            for (const node of recapNodes) {
                const messageNode = node as MessageNode;
                expect(typeof messageNode.message!.content.content).toBe('string');
            }
        });
    });
});
