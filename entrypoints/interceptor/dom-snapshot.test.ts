import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Window } from 'happy-dom';
import { buildDomConversationSnapshot } from './dom-snapshot';

describe('dom-snapshot', () => {
    let windowInstance: Window;

    beforeEach(() => {
        windowInstance = new Window();
        (windowInstance as any).SyntaxError = SyntaxError;
        (globalThis as any).window = windowInstance;
        (globalThis as any).document = windowInstance.document;
    });

    afterEach(() => {
        delete (globalThis as any).window;
        delete (globalThis as any).document;
    });

    it('should preserve thoughts in content for mixed text+thought turns', () => {
        const { document } = windowInstance;
        document.title = 'Mixed Turn - ChatGPT';

        const turn = document.createElement('div');
        turn.setAttribute('data-testid', 'conversation-turn-1');

        const role = document.createElement('div');
        role.setAttribute('data-message-author-role', 'assistant');

        const textNode = document.createElement('div');
        textNode.setAttribute('data-message-content', '');
        textNode.textContent = 'Final answer text';

        const details = document.createElement('details');
        const summary = document.createElement('summary');
        summary.textContent = 'Reasoning summary';
        details.appendChild(summary);

        role.appendChild(textNode);
        role.appendChild(details);
        turn.appendChild(role);
        document.body.appendChild(turn);

        const snapshot = buildDomConversationSnapshot('conv-1') as any;
        expect(snapshot).not.toBeNull();

        const assistantMessage = Object.values(snapshot.mapping)
            .map((node: any) => node.message)
            .find((message: any) => message?.author?.role === 'assistant');
        expect(assistantMessage).toBeDefined();
        expect(assistantMessage.content?.content_type).toBe('text');
        expect(assistantMessage.content?.parts).toEqual(['Final answer text']);
        expect(Array.isArray(assistantMessage.content?.thoughts)).toBeTrue();
        expect(assistantMessage.content?.thoughts?.[0]).toMatchObject({
            summary: 'Reasoning summary',
            content: 'Reasoning summary',
            chunks: [],
            finished: true,
        });
    });
});
