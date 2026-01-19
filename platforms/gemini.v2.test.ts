import { describe, expect, it } from 'bun:test';
import { geminiAdapter } from './gemini';

describe('Gemini Adapter V2 Parsing', () => {
    it('should parse reasoning data and assistant response correctly from batchexecute structure', () => {
        // Construct a mock payload matching the structure we discovered
        // Structure: [[[["c_id", "r_id"], null, [USER_PART], [ASSISTANT_PART]]]]

        const conversationId = 'c_12345';
        const responseId = 'r_67890';

        // User Part (Index 2 in conversation container)
        // Based on logs: [["ROLE: User Prompt..."]]
        const userPart = [['ROLE: This is the user prompt']];

        // Reasoning Data (Index 37 in candidate)
        const reasoningData = [
            [null, [null, 0, 'Thinking Step 1']], // Title
            [null, [null, 0, 'Content of thought 1']], // Body
            [null, [null, 0, 'Thinking Step 2']], // Title
            [null, [null, 0, 'Content of thought 2']], // Body
        ];

        // Candidate (Inside Assistant Part)
        // Index 0: rc_id
        // Index 1: [Content String]
        // Index 37: Reasoning Data
        const candidate = [];
        candidate[0] = 'rc_test';
        candidate[1] = ['This is the final assistant response text.'];
        candidate[37] = reasoningData;

        // Assistant Part (Index 3 in conversation container)
        // Array of candidates
        const assistantPart = [candidate];

        // Conversation Container
        const conversationContainer = [
            [conversationId, responseId], // Index 0
            null, // Index 1
            userPart, // Index 2
            assistantPart, // Index 3
        ];

        // Inner Payload
        // [[conversationContainer]]
        const innerPayload = [[conversationContainer]];

        // Envelope
        const envelope = [['wrb.fr', 'hNvQHb', JSON.stringify(innerPayload), null, 'generic']];

        // Raw Response String (Gemini format)
        // )]}' \n length \n [envelope]
        // Note: envelope IS the wrapper array [[rpc1]]
        const rawResponse = `)]}'\n\n1234\n${JSON.stringify(envelope)}`;

        const result = geminiAdapter.parseInterceptedData(rawResponse, 'https://gemini.google.com/app/c_12345');

        expect(result).not.toBeNull();
        expect(result?.conversation_id).toBe('12345');

        const mapping = result?.mapping;
        expect(mapping).toBeDefined();

        // Count segments
        const segments = Object.keys(mapping!);
        expect(segments.length).toBe(2);

        // Check User Message
        const userMsg = mapping?.['segment-0']?.message;
        expect(userMsg?.author.role).toBe('user');
        expect(userMsg?.content.parts?.[0]).toContain('This is the user prompt');

        // Check Assistant Message
        const assistantMsg = mapping?.['segment-1']?.message;
        expect(assistantMsg?.author.role).toBe('assistant');
        expect(assistantMsg?.content.parts?.[0]).toBe('This is the final assistant response text.');

        // Check Reasoning
        expect(assistantMsg?.content.thoughts).toBeDefined();
        expect(assistantMsg?.content.thoughts?.length).toBe(2);

        expect(assistantMsg?.content.thoughts?.[0].summary).toBe('Thinking Step 1');
        expect(assistantMsg?.content.thoughts?.[0].content).toBe('Content of thought 1');

        expect(assistantMsg?.content.thoughts?.[1].summary).toBe('Thinking Step 2');
        expect(assistantMsg?.content.thoughts?.[1].content).toBe('Content of thought 2');
    });
});
