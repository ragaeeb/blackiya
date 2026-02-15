export function normalizeHashInput(value: string): string {
    return value.trim().normalize('NFC');
}

export function hashText(value: string): string {
    const normalized = normalizeHashInput(value);
    let hash = 0;
    for (let i = 0; i < normalized.length; i++) {
        hash = (hash << 5) - hash + normalized.charCodeAt(i);
        hash |= 0;
    }
    return `${hash}`;
}
