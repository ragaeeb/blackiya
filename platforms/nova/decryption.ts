type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
    value !== null && typeof value === 'object' && !Array.isArray(value);

const fromBase64 = (value: string) => Uint8Array.from(atob(value), (character) => character.charCodeAt(0));

const decryptString = async (value: string, key: CryptoKey): Promise<string> => {
    if (!value.startsWith('Enc~')) {
        return value;
    }
    const encrypted = fromBase64(value.slice(4));
    if (encrypted.byteLength <= 28) {
        throw new Error('Invalid Nova encrypted value.');
    }
    const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: encrypted.slice(0, 12), tagLength: 128 },
        key,
        encrypted.slice(12),
    );
    return new TextDecoder().decode(decrypted);
};

const decryptValue = async (value: unknown, key: CryptoKey): Promise<unknown> => {
    if (typeof value === 'string') {
        return decryptString(value, key);
    }
    if (Array.isArray(value)) {
        return Promise.all(value.map((entry) => decryptValue(entry, key)));
    }
    if (isRecord(value)) {
        const entries = await Promise.all(
            Object.entries(value).map(async ([name, entry]) => [name, await decryptValue(entry, key)] as const),
        );
        return Object.fromEntries(entries);
    }
    return value;
};

export const decryptNovaConversationResponseText = async (responseText: string): Promise<string | null> => {
    try {
        const payload: unknown = JSON.parse(responseText);
        if (!isRecord(payload) || !Array.isArray(payload.conversationInteractions)) {
            return null;
        }
        if (typeof payload.plaintextKey !== 'string') {
            return responseText.includes('Enc~') ? null : responseText;
        }
        const key = await crypto.subtle.importKey('raw', fromBase64(payload.plaintextKey), 'AES-GCM', false, [
            'decrypt',
        ]);
        const conversationInteractions = await decryptValue(payload.conversationInteractions, key);
        const { plaintextKey: _, ...safePayload } = payload;
        return JSON.stringify({ ...safePayload, conversationInteractions });
    } catch {
        return null;
    }
};
