/**
 * Return a Firestore query-safe encoded copy of `str`.
 *
 * Inspired by https://stackoverflow.com/a/19148116.
 */
export function firestoreEncode(str) {
  return encodeURIComponent(str).replace(/\./g, '%2E');
}

/**
 * The inverse of `firestoreEncode`.
 */
export function firestoreDecode(str) {
  return decodeURIComponent(str.replace(/\./g, '%2E'));
}
