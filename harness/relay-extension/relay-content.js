(() => {
    const messageType = 'BLACKIYA_DEV_RELAY_EVENT';

    window.addEventListener('message', (event) => {
        if (event.source !== window || event.origin !== window.location.origin) {
            return;
        }
        const data = event.data;
        if (!data || typeof data !== 'object' || data.type !== messageType) {
            return;
        }
        if (!data.event || typeof data.event !== 'object' || Array.isArray(data.event)) {
            return;
        }
        void chrome.runtime.sendMessage({
            type: messageType,
            event: data.event,
        });
    });
})();
