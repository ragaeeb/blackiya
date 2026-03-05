import type { LLMPlatform } from '@/platforms/types';

export const resolveHeaderCaptureAdapter = (
    contextAdapter: LLMPlatform | null,
    apiAdapter: LLMPlatform | null,
    completionAdapter: LLMPlatform | null,
): LLMPlatform | null => contextAdapter ?? apiAdapter ?? completionAdapter ?? null;
