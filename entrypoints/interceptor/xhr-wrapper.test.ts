import { describe, expect, it, mock } from 'bun:test';
import { notifyXhrOpen } from './xhr-wrapper';

describe('xhr-wrapper', () => {
    it('should invoke the onOpen handler with method and url', () => {
        const onOpen = mock(() => {});
        notifyXhrOpen('GET', 'https://example.com/api', onOpen);
        expect(onOpen).toHaveBeenCalledTimes(1);
        expect(onOpen).toHaveBeenCalledWith('GET', 'https://example.com/api');
    });

    it('should pass through any method string unchanged', () => {
        const received: Array<[string, string]> = [];
        const onOpen = (method: string, url: string) => {
            received.push([method, url]);
        };

        notifyXhrOpen('POST', 'https://api.example.com/submit', onOpen);
        expect(received).toEqual([['POST', 'https://api.example.com/submit']]);
    });

    it('should work with empty strings without throwing', () => {
        const onOpen = mock(() => {});
        notifyXhrOpen('', '', onOpen);
        expect(onOpen).toHaveBeenCalledWith('', '');
    });
});
