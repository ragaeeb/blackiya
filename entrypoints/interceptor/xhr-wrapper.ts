export type XhrOpenHandler = (method: string, url: string) => void;

export const notifyXhrOpen = (method: string, url: string, onOpen: XhrOpenHandler) => {
    onOpen(method, url);
};
