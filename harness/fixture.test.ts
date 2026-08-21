import { describe, expect, it } from 'bun:test';
import { Window } from 'happy-dom';
import { createChatGPTAdapter } from '@/platforms/chatgpt';
import {
    createHarnessConversationPayload,
    createHarnessConversationListPayload,
    HARNESS_CONVERSATION_ID,
    HARNESS_AUTHORIZATION,
    isValidHarnessAuthorization,
    simulateChatGPTArtifactDownload,
} from './fixture';

describe('browser harness fixture', () => {
    it('should require the exact fixture authorization value', () => {
        expect(isValidHarnessAuthorization(HARNESS_AUTHORIZATION)).toBe(true);
        expect(isValidHarnessAuthorization('Bearer another-token')).toBe(false);
        expect(isValidHarnessAuthorization(undefined)).toBe(false);
    });

    it('should provide a finished canonical ChatGPT payload', () => {
        const adapter = createChatGPTAdapter();
        const payload = createHarnessConversationPayload();
        const parsed = adapter.parseInterceptedData(
            JSON.stringify(payload),
            `http://127.0.0.1:4177/backend-api/conversation/${HARNESS_CONVERSATION_ID}`,
        );

        expect(parsed?.conversation_id).toBe(HARNESS_CONVERSATION_ID);
        expect(parsed?.current_node).toBe(payload.current_node);
        expect(adapter.evaluateReadiness?.(parsed!)).toMatchObject({ ready: true, terminal: true });
    });

    it('should provide one conversation for the popup bulk-export boundary', () => {
        expect(createHarnessConversationListPayload()).toEqual({
            items: [{ id: HARNESS_CONVERSATION_ID, title: 'Bootstrap Mewzimen Evaluator' }],
        });
    });

    it('should provide a non-terminal payload for deterministic failure coverage', () => {
        const adapter = createChatGPTAdapter();
        const payload = createHarnessConversationPayload(HARNESS_CONVERSATION_ID, 'not-terminal');
        const parsed = adapter.parseInterceptedData(
            JSON.stringify(payload),
            `http://127.0.0.1:4177/backend-api/conversation/${HARNESS_CONVERSATION_ID}`,
        );

        expect(adapter.evaluateReadiness?.(parsed!)).toMatchObject({
            ready: false,
            terminal: false,
            reason: 'assistant-in-progress',
        });
    });

    it('should provide a finished multimodal payload for artifact-response coverage', () => {
        const adapter = createChatGPTAdapter();
        const payload = createHarnessConversationPayload(HARNESS_CONVERSATION_ID, 'multimodal');
        const parsed = adapter.parseInterceptedData(
            JSON.stringify(payload),
            `http://127.0.0.1:4177/backend-api/conversation/${HARNESS_CONVERSATION_ID}`,
        );

        expect(parsed?.mapping[payload.current_node]?.message?.content.content_type).toBe('multimodal_text');
        expect(adapter.evaluateReadiness?.(parsed!)).toMatchObject({ ready: true, terminal: true });
    });

    it('should model ChatGPT replacing the page host when a file download opens the artifact preview', () => {
        const windowInstance = new Window();
        const { document } = windowInstance;
        document.body.innerHTML =
            '<header><div id="harness-model-switcher"></div></header><section id="harness-artifact-preview" hidden></section>';
        const originalHost = document.querySelector('#harness-model-switcher');
        const extensionControls = document.createElement('div');
        extensionControls.id = 'blackiya-v3-export-controls';
        extensionControls.setAttribute('data-blackiya-export-controls', '1');
        document.body.appendChild(extensionControls);

        simulateChatGPTArtifactDownload(document as unknown as Document);

        expect(document.querySelector('#harness-model-switcher')).not.toBe(originalHost);
        expect(document.querySelector('#harness-model-switcher')?.getAttribute('data-harness-replaced')).toBe('true');
        expect(document.querySelector('#harness-model-switcher')?.contains(extensionControls)).toBe(true);
        expect(extensionControls.isConnected).toBe(true);
        const artifactPreview = document.querySelector('#harness-artifact-preview') as unknown as {
            hidden: boolean;
        } | null;
        expect(artifactPreview?.hidden).toBe(false);
        expect(document.querySelector('#harness-artifact-preview')?.getAttribute('data-harness-open')).toBe('true');
        windowInstance.close();
    });
});
