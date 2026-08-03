// Bibliography / References cleanup for vision + structured reading.
// Models often invent OCR/layout "line numbers" before citation markers
// (e.g. "695: [16] Author…") and algorithm recovery can mistake dense [n]
// lists for pseudocode steps. Keep a clean academic form:
//   [16] Y. Wang, Z. Lü, …, Journal …, 2013.
// and never drop the first complete entry on the page.

/** One line/paragraph that is a numbered bibliography entry. */
export function looksLikeBibliographyEntry(value) {
  const raw = String(value || '').replace(/\s+/gu, ' ').trim();
  if (!raw || raw.length < 18 || raw.length > 1400) return false;

  // Drop layout junk "695: [16] …" before testing.
  const text = raw.replace(/^\d{1,4}\s*[:：]\s*/u, '');

  const bracket = /^\[\s*\d{1,4}\s*\]\s+\S/u.test(text);
  const dotted = /^\d{1,3}\.\s+[A-ZÀ-ÖØ-Þ]/u.test(text);
  if (!bracket && !dotted) return false;

  // Body citations like "see [12] for details" are short and lack biblio signals.
  const hasYear = /\b(?:19|20)\d{2}\b/u.test(text);
  const hasVenue = /\b(?:arXiv|Springer|IEEE|ACM|Elsevier|Wiley|Nature|Science|pp\.|Vol\.|Proceedings|Journal|Conference|Workshop|Lecture Notes|Tech\.?\s*Rep|Report)\b/iu.test(text);
  const hasAuthorComma = /^\[\s*\d{1,4}\s*\]\s+[A-ZÀ-ÖØ-Þ].{8,},/u.test(text)
    || /^\d{1,3}\.\s+[A-ZÀ-ÖØ-Þ].{8,},/u.test(text);
  if (hasYear || hasVenue || hasAuthorComma) return true;

  // Longer [n] lines with multiple commas are usually reference entries.
  const commas = (text.match(/,/g) || []).length;
  return bracket && commas >= 2 && text.length >= 40;
}

/** Dense reference list (page or multi-entry blob) — not pseudocode. */
export function looksLikeBibliographyList(value) {
  const text = String(value || '');
  if (!text.trim()) return false;
  if (/参考文献|^\s*#{0,3}\s*References\b/imu.test(text)) {
    const markers = text.match(/\[\s*\d{1,4}\s*\]/gu) || [];
    if (markers.length >= 1) return true;
  }

  // "695: [16]" / "107: [17]" junk is a strong vision failure signal.
  const fakeSteps = text.match(/\d{1,4}\s*[:：]\s*\[\s*\d{1,4}\s*\]/gu) || [];
  if (fakeSteps.length >= 2) return true;

  const withAuthor = text.match(/\[\s*\d{1,4}\s*\]\s*[A-ZÀ-ÖØ-Þ]/gu) || [];
  if (withAuthor.length >= 2) return true;

  // Vision output sometimes loses the [n] markers or moves a publication year
  // to the start of the next line ("2023: Author, ..."). Those references
  // must still be protected from the pseudocode formatter. Require repeated,
  // high-confidence citation vocabulary so ordinary related-work prose is not
  // classified as a bibliography merely because it mentions one paper.
  const arxivEntries = text.match(/\barXiv\s+preprint\s+arXiv\s*:/giu) || [];
  const citationSignals = text.match(/\b(?:doi\s*:|arXiv\s*:|Journal|Proceedings|Transactions|Conference|Springer|Elsevier|Wiley|IEEE|ACM|Cambridge University Press)\b/giu) || [];
  const publicationYears = text.match(/(?:^|[\s,(])(?:19|20)\d{2}[a-z]?(?=[\s.,;:)]|$)/gimu) || [];
  const yearLedEntries = text.match(/(?:^|\n)\s*(?:19|20)\d{2}[a-z]?\s*[:.：]\s*[A-ZÀ-ÖØ-Þ][^\n]{24,}/gmu) || [];
  const commaCount = (text.match(/[,，]/gu) || []).length;
  const authorLedEntry = /^\s*(?:(?:19|20)\d{2}[a-z]?\s*[:.：]\s*)?[A-ZÀ-ÖØ-Þ][A-Za-zÀ-ÖØ-öø-ÿ'’-]{1,32},\s+(?:[A-Z](?:\.-?|\b)){1,4}[,.;]/mu.test(text);
  if (text.trim().length >= 80 && authorLedEntry && citationSignals.length >= 1
    && publicationYears.length >= 1 && commaCount >= 3) return true;
  if (arxivEntries.length >= 2 && commaCount >= 4) return true;
  if (citationSignals.length >= 3 && publicationYears.length >= 2 && commaCount >= 5) return true;
  if (yearLedEntries.length >= 2 && citationSignals.length >= 2) return true;

  // Several standalone entries separated by newlines.
  const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const entryLines = lines.filter((l) => looksLikeBibliographyEntry(l));
  return entryLines.length >= 2;
}

/**
 * Strip OCR/layout numbers glued before citation markers:
 *   "695: [16] Author" → "[16] Author"
 *   "296:[2] F. Harary" → "[2] F. Harary"
 * Safe on body text: "see 12: [note]" is rare; we require [digits] right after.
 */
export function stripSpuriousBibliographyLineNumbers(text) {
  return String(text || '').replace(
    /(^|[\n\r])([ \t]*)\d{1,4}\s*[:：]\s*(?=\[\s*\d{1,4}\s*\])/gu,
    '$1$2',
  );
}

/**
 * Normalize a page (or region) of bibliography Markdown into clean entries:
 *   [n] Author, Title, Venue, year…
 * Does not invent missing entries (e.g. dropped [1]); only cleans format.
 */
export function normalizeBibliographyMarkdown(markdown) {
  let s = stripSpuriousBibliographyLineNumbers(String(markdown || ''));
  if (!s.trim()) return s;

  // A model may incorrectly wrap references in ```algorithm or a plain code
  // fence. Unwrap only when the fenced body independently looks like a
  // bibliography; genuine code and pseudocode fences remain untouched.
  s = s.replace(
    /```(?:algorithm|pseudo|pseudocode|algo)?[ \t]*\n([\s\S]*?)```/giu,
    (full, body) => (looksLikeBibliographyList(body) ? String(body).trim() : full),
  );

  // Only apply paragraph separation when this looks like a reference block —
  // never split inline body citations.
  if (!looksLikeBibliographyList(s)) return s;

  // Ensure each [n] / "n. Author" that starts an entry sits on its own paragraph.
  s = s.replace(
    /([^\n])\n([ \t]*)(\[\s*\d{1,4}\s*\]\s+\S)/gu,
    '$1\n\n$2$3',
  );
  s = s.replace(
    /([^\n])\n([ \t]*)(\d{1,3}\.\s+[A-ZÀ-ÖØ-Þ])/gu,
    '$1\n\n$2$3',
  );

  // Some visual models omit [n] and emit one reference per line, occasionally
  // with a displaced year prefix such as "2023: Wu, X., ...". Keep those as
  // ordinary readable paragraphs rather than one wall of text.
  s = s.replace(
    /([^\n])\n([ \t]*)((?:19|20)\d{2}[a-z]?\s*[:.：]\s+[A-ZÀ-ÖØ-Þ])/gmu,
    '$1\n\n$2$3',
  );
  s = s.replace(
    /([^\n])\n([ \t]*)([A-ZÀ-ÖØ-Þ][A-Za-zÀ-ÖØ-öø-ÿ'’-]{1,32},\s+(?:[A-Z](?:\.-?|\b)){1,4}[,.;])/gmu,
    '$1\n\n$2$3',
  );

  // Collapse 3+ blank lines introduced by cleanup.
  s = s.replace(/\n{3,}/g, '\n\n');
  return s;
}
