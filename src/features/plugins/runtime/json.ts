import {type JsonValue} from '../sdk/types'

export function isPlainRecord(
  value: unknown,
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isJsonValue(
  value: unknown,
  seen: WeakSet<object>,
): value is JsonValue {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string'
  ) {
    return true
  }
  if (typeof value === 'number') {
    return Number.isFinite(value)
  }
  if (typeof value !== 'object') {
    return false
  }
  if (seen.has(value)) {
    return false
  }
  seen.add(value)
  let valid: boolean
  if (Array.isArray(value)) {
    valid = value.every(entry => isJsonValue(entry, seen))
  } else if (isPlainRecord(value)) {
    valid = Object.values(value).every(entry => isJsonValue(entry, seen))
  } else {
    valid = false
  }
  seen.delete(value)
  return valid
}

/**
 * Runtime guard for values that survive a JSON round-trip. Rejects undefined,
 * functions, symbols, bigint, non-finite numbers, class instances and cycles.
 */
export function isJsonSerializable(value: unknown): value is JsonValue {
  return isJsonValue(value, new WeakSet())
}
