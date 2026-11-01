import {type PluginCapability, type PluginPlatform} from '../sdk/types'

/**
 * One enabled plugin as published by the public registry. The registry only
 * controls plugins already compiled into the app; it cannot inject code.
 */
export type PluginRegistryEntry = {
  id: string
  version: string
  hostApi: number
  platforms: PluginPlatform[]
  capabilities: PluginCapability[]
  /**
   * Raw values keyed by manifest setting key. Values are validated against the
   * manifest field type when the plugin is resolved.
   */
  settings: Record<string, unknown>
}

export type PluginRegistrySnapshot = {
  revision: number
  generatedAt: string
  plugins: PluginRegistryEntry[]
}

/**
 * Last successful registry state. The ETag is sent as `If-None-Match` on the
 * next request.
 */
export type CachedPluginRegistry = {
  etag: string | undefined
  snapshot: PluginRegistrySnapshot
}

export type PluginRegistryFailureReason =
  | 'network'
  | 'timeout'
  | 'http-status'
  | 'too-large'
  | 'too-many-plugins'
  | 'invalid-structure'
  | 'invalid-json'

export type PluginRegistrySyncResult =
  | {
      status: 'disabled'
      reason: 'not-configured' | 'invalid-url'
    }
  | {
      status: 'not-modified'
      registry: CachedPluginRegistry | undefined
    }
  | {
      status: 'updated'
      registry: CachedPluginRegistry
      cacheWriteFailed: boolean
    }
  | {
      status: 'failed'
      reason: PluginRegistryFailureReason
      httpStatus?: number
      registry: CachedPluginRegistry | undefined
    }
