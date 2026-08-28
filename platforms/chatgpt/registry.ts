export const CHATGPT_SELECTOR_REGISTRY = {
    generationIndicators: [
        'button[data-testid="stop-button"]',
        'button[aria-label*="Stop generating"]',
        'button[aria-label*="Stop response"]',
        'button[aria-label="Stop"]',
        '[data-is-streaming="true"]',
    ],
} as const;

export const isChatGptGeneratingFromDom = (
    doc: Pick<Document, 'querySelector'> | null = typeof document === 'undefined' ? null : document,
) => {
    if (!doc) {
        return false;
    }
    return CHATGPT_SELECTOR_REGISTRY.generationIndicators.some((selector) => {
        const indicator = doc.querySelector(selector) as { disabled?: boolean } | null;
        return Boolean(indicator && indicator.disabled !== true);
    });
};
