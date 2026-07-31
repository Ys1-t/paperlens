// PDF navigation policy.
//
// PaperLens used to install persistent Declarative Net Request redirects for
// ordinary PDF and arXiv navigation.  Keep the old rule IDs here only so an
// upgraded installation can remove them.  Opening the translation reader is
// now exclusively driven by explicit UI actions (popup, context menu, or a
// runtime openViewer message).

export const LEGACY_PDF_REDIRECT_RULE_IDS = Object.freeze([1001, 1002]);

export async function removeLegacyPdfRedirectRules(declarativeNetRequest) {
  if (typeof declarativeNetRequest?.updateDynamicRules !== 'function') return false;
  await declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [...LEGACY_PDF_REDIRECT_RULE_IDS],
    addRules: [],
  });
  return true;
}
