import {jsonByteLength} from '../runtime/bytes'
import {isJsonSerializable, isPlainRecord} from '../runtime/json'
import {createNativePluginError} from './errors'
import {type NativePluginError} from './types'

export const NATIVE_VIEW_PROPS_MAX_BYTES = 64 * 1024
export const NATIVE_VIEW_EVENT_MAX_BYTES = 32 * 1024

export type NativePayloadValidation =
  | {ok: true; value: Readonly<Record<string, unknown>>}
  | {ok: false; error: NativePluginError}

function invalid(message: string): NativePayloadValidation {
  return {
    ok: false,
    error: createNativePluginError('invalid_argument', message),
  }
}

function tooLarge(message: string): NativePayloadValidation {
  return {ok: false, error: createNativePluginError('too_large', message)}
}

function validateRecord(
  value: unknown,
  maxBytes: number,
  invalidMessage: string,
  tooLargeMessage: string,
): NativePayloadValidation {
  if (value === undefined) return {ok: true, value: {}}
  if (!isPlainRecord(value) || !isJsonSerializable(value)) {
    return invalid(invalidMessage)
  }
  if (jsonByteLength(value) > maxBytes) {
    return tooLarge(tooLargeMessage)
  }
  return {ok: true, value}
}

/**
 * Props are a bounded JSON object. Tokens, secrets and account objects remain
 * the plugin's responsibility; the host only enforces the transport contract.
 */
export function validateNativeViewProps(
  value: unknown,
): NativePayloadValidation {
  return validateRecord(
    value,
    NATIVE_VIEW_PROPS_MAX_BYTES,
    '插件视图参数无效，无法显示。',
    '插件视图参数超出允许的大小，无法显示。',
  )
}

export function validateNativeViewEventPayload(
  value: unknown,
): NativePayloadValidation {
  return validateRecord(
    value,
    NATIVE_VIEW_EVENT_MAX_BYTES,
    '插件事件数据无效，已忽略。',
    '插件事件数据超出允许的大小，已忽略。',
  )
}
