// Shared by the viewer and service worker so an old extension page cannot keep
// talking to a newer background bundle under the same manifest version.
export const PAPERLENS_BUILD_ID = '2026.07.30-gen16-v1.2.6';
export const TRANSLATION_PIPELINE_VERSION = 'vision-page-v12';
export const TRANSLATION_PORT_NAME = `translate:${PAPERLENS_BUILD_ID}`;
