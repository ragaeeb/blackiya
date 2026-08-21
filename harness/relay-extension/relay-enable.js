(() => {
    const defaultRelayUrl = 'http://127.0.0.1:4177/events';
    const enabled = document.querySelector('#relay-enabled');
    const urlInput = document.querySelector('#relay-url');
    const save = document.querySelector('#save');
    const status = document.querySelector('#status');

    const isLocalRelayUrl = (value) => {
        try {
            const url = new URL(value);
            return (
                url.protocol === 'http:' &&
                (url.hostname === '127.0.0.1' || url.hostname === 'localhost') &&
                url.pathname === '/events' &&
                !url.search &&
                !url.hash
            );
        } catch {
            return false;
        }
    };

    chrome.storage.local.get({ relayEnabled: false, relayUrl: defaultRelayUrl }, (config) => {
        enabled.checked = config.relayEnabled === true;
        urlInput.value = String(config.relayUrl || defaultRelayUrl);
    });

    save.addEventListener('click', () => {
        const relayUrl = urlInput.value.trim();
        if (!isLocalRelayUrl(relayUrl)) {
            status.textContent = 'Use an http://localhost or http://127.0.0.1 /events URL.';
            return;
        }
        chrome.storage.local.set({ relayEnabled: enabled.checked, relayUrl }, () => {
            status.textContent = enabled.checked ? 'Relay enabled for this development profile.' : 'Relay disabled.';
        });
    });
})();
