const unsafeKeys = /password|passwd|secret|token|cookie|authorization|body|headers|session|credential|private.?key|verification.?code|^value$/i;
export function redactDiagnostic(value: unknown, key = ''): unknown {
  if (unsafeKeys.test(key)) return '[REDACTED]';
  if (Array.isArray(value)) return value.slice(0, 256).map(v => redactDiagnostic(v));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 256).map(([k,v]) => [k, redactDiagnostic(v,k)]));
  if (typeof value === 'string') return value.slice(0, 8192)
    .replace(/https?:\/\/[^\s"<>]+/g, text => { try { const u = new URL(text); return `${u.protocol}//${u.host}${u.pathname}`; } catch { return '[REDACTED URL]'; } })
    .replace(/((?:password|passwd|token|secret|cookie|authorization|sid)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]');
  return value;
}
