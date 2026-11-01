/**
 * UTF-8 byte length without relying on TextEncoder, which is not available in
 * every React Native runtime. JSON.stringify escapes lone surrogates, so the
 * serialized representation and this counter always agree.
 */
export function utf8ByteLength(value: string): number {
  let bytes = 0
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code < 0x80) {
      bytes += 1
    } else if (code < 0x800) {
      bytes += 2
    } else if (code >= 0xd800 && code <= 0xdbff) {
      // Surrogate pair, four bytes for the code point.
      bytes += 4
      index++
    } else {
      bytes += 3
    }
  }
  return bytes
}

/**
 * Byte length of the JSON serialization of a value. Throws when the value
 * cannot be serialized (e.g. circular structures).
 */
export function jsonByteLength(value: unknown): number {
  return utf8ByteLength(JSON.stringify(value))
}
