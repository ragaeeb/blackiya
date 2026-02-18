export function appendStreamProbePreview(existing: string, delta: string, maxLength = 12000): string {
    const merged = `${existing}${delta}`;
    if (merged.length <= maxLength) {
        return merged;
    }
    if (maxLength <= 3) {
        return merged.slice(merged.length - maxLength);
    }
    return `...${merged.slice(merged.length - (maxLength - 3))}`;
}
