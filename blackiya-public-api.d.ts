import type { BridgeErrorCode } from '@/entrypoints/interceptor/public-api-contract';
import type { JsonBridgeFormat } from '@/entrypoints/interceptor/snapshot-bridge';
import type { BlackiyaPublicEventName, BlackiyaPublicStatus } from '@/utils/protocol/messages';

export type BlackiyaPublicSubscriptionOptions = {
    emitCurrent?: boolean;
};

export type BlackiyaWaitForReadyOptions = {
    timeoutMs?: number;
    emitCurrent?: boolean;
};

export type BlackiyaPublicApi = {
    version: string;
    getJSON: () => Promise<unknown>;
    getCommonJSON: () => Promise<unknown>;
    getStatus: () => BlackiyaPublicStatus;
    waitForReady: (options?: BlackiyaWaitForReadyOptions) => Promise<BlackiyaPublicStatus>;
    subscribe: (
        event: BlackiyaPublicEventName,
        callback: (status: BlackiyaPublicStatus) => void,
        options?: BlackiyaPublicSubscriptionOptions,
    ) => () => void;
    onStatusChange: (
        callback: (status: BlackiyaPublicStatus) => void,
        options?: BlackiyaPublicSubscriptionOptions,
    ) => () => void;
    onReady: (
        callback: (status: BlackiyaPublicStatus) => void,
        options?: BlackiyaPublicSubscriptionOptions,
    ) => () => void;
};

export type BlackiyaBridgeError = Error & {
    name: 'BlackiyaBridgeError';
    code: BridgeErrorCode;
    details?: string;
};

export type BlackiyaJsonBridgeFormat = JsonBridgeFormat;

declare global {
    // biome-ignore lint/style/useConsistentTypeDefinitions: global Window augmentation requires interface merging
    interface Window {
        __blackiya?: BlackiyaPublicApi;
    }
}
