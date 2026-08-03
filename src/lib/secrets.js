/** Return a display-safe API key mask. */
export function maskApiKey(value) {
  const key = String(value ?? '');
  if (!key) return '(空)';
  if (key.length <= 8) return '****';
  return `${key.slice(0, 4)}****${key.slice(-2)}`;
}

/** Remove credentials that may appear in errors, logs, or diagnostics. */
export function redactSecrets(value, knownKeys = []) {
  let text = String(value ?? '');
  for (const key of knownKeys.filter(Boolean).map(String).sort((a, b) => b.length - a.length)) {
    text = text.split(key).join('***');
  }
  text = text.replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer ***');
  text = text.replace(/([?&](?:key|api_key|apikey|api-key|x-api-key|token|access_token)=)[^&#\s]+/gi, '$1***');
  text = text.replace(/(https?:\/\/)[^/@\s]+@/gi, '$1***@');
  return text;
}
