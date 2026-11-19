// URLs that reach results.json, results.md or the console lose their query string and fragment:
// a sign-in callback carries `?code=…&state=…`, and nothing the driver reports needs either part.

/** `https://h/p?code=1#x` → `https://h/p`. Non-URL text is returned unchanged. */
export function redactUrl(url) {
  return String(url ?? '').replace(/[?#].*$/s, '');
}

/** Strips the query and fragment of every http(s) URL inside free text (error messages, logs). */
export function redactText(text) {
  return String(text ?? '').replace(/\b(https?:\/\/[^\s?#'"<>]*)[?#][^\s'"<>]*/g, '$1');
}
