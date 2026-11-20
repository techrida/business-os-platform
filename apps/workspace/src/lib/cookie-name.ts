export function cookieName(kind: 'session' | 'login' | 'signed_out'): string {
  const namespace =
    process.env.NODE_ENV === 'development' ? process.env.BOS_DEV_COOKIE_NAMESPACE : undefined;
  if (namespace === undefined) return `__Host-bos_${kind}`;
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(namespace)) {
    throw new Error(
      'BOS_DEV_COOKIE_NAMESPACE must be 1-32 lowercase letters, digits or hyphens, starting with a letter',
    );
  }
  return `__Host-bos_${namespace}_${kind}`;
}
