import { describe, expect, it } from 'bun:test';
import { decryptNovaConversationResponseText } from './decryption';
import { createNovaConversationFixture } from './fixtures/conversation';
import { parseNovaConversationPayload } from './parser';

const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

const encrypt = async (text: string, keyBytes: Uint8Array) => {
    const iv = new Uint8Array(12).fill(7);
    const key = await crypto.subtle.importKey('raw', new Uint8Array(keyBytes).buffer, 'AES-GCM', false, ['encrypt']);
    const ciphertext = new Uint8Array(
        await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text)),
    );
    return `Enc~${toBase64(new Uint8Array([...iv, ...ciphertext]))}`;
};

describe('Amazon Nova encrypted conversation responses', () => {
    it('should decrypt message content and remove the response-local plaintext key', async () => {
        const keyBytes = new Uint8Array(32).fill(11);
        const encrypted = createNovaConversationFixture({
            assistantContent: [
                {
                    type: 'text',
                    text: await encrypt('## Executive Answer\n\nSanitized answer.', keyBytes),
                    reasoningBlocks: [{ index: 0, text: await encrypt('Sanitized reasoning.', keyBytes) }],
                },
            ],
        }) as Record<string, unknown>;
        encrypted.plaintextKey = toBase64(keyBytes);

        const decryptedText = await decryptNovaConversationResponseText(JSON.stringify(encrypted));
        const decryptedPayload = decryptedText ? (JSON.parse(decryptedText) as Record<string, unknown>) : null;
        const parsed = decryptedPayload ? parseNovaConversationPayload(decryptedPayload) : null;

        expect(decryptedPayload).not.toHaveProperty('plaintextKey');
        expect(JSON.stringify(decryptedPayload)).not.toContain('Enc~');
        expect(JSON.stringify(parsed)).toContain('Executive Answer');
    });

    it('should fail closed when encrypted content cannot be decrypted', async () => {
        const encrypted = createNovaConversationFixture({
            assistantContent: [{ type: 'text', text: 'Enc~bm90LWFuLWFlcy1nY20tcGF5bG9hZA==' }],
        }) as Record<string, unknown>;
        encrypted.plaintextKey = toBase64(new Uint8Array(32).fill(3));

        expect(await decryptNovaConversationResponseText(JSON.stringify(encrypted))).toBeNull();
    });
});
