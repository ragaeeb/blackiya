import { META_ARTIFACT_URLS } from '@/platforms/constants';
import { publishMetaArtifactToParent } from '@/platforms/meta/artifacts';

const defineScript = typeof defineContentScript !== 'undefined' ? defineContentScript : (config: any) => config;

export default defineScript({
    matches: [...META_ARTIFACT_URLS],
    allFrames: true,
    world: 'MAIN',
    runAt: 'document_idle',
    main() {
        publishMetaArtifactToParent(window);
    },
});
