export type PluginManifest = {
  readonly id: string
}

export type PluginDefinition = {
  readonly manifest: PluginManifest
  readonly slots: Record<string, () => null>
}

export function parsePluginManifest(value: unknown): PluginManifest {
  return value as PluginManifest
}
