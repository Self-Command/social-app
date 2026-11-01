import {
  type PluginSlotComponent,
  type PluginSlotContextMap,
  type PluginSlotId,
} from '../sdk/types'
import {usePluginHost} from './plugin-context'
import {PluginErrorBoundary} from './PluginErrorBoundary'
import {type ResolvedPlugin} from './resolve'

export type PluginSlotRendererProps<S extends PluginSlotId> = {
  id: S
  context: PluginSlotContextMap[S]
}

export function getPluginsForSlot(
  plugins: readonly ResolvedPlugin[],
  slotId: PluginSlotId,
): ResolvedPlugin[] {
  const entries: {plugin: ResolvedPlugin; order: number}[] = []
  for (const plugin of plugins) {
    const declaration = plugin.definition.manifest.slots.find(
      slot => slot.id === slotId,
    )
    if (declaration) {
      entries.push({plugin, order: declaration.order})
    }
  }
  entries.sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order
    const aId = a.plugin.definition.manifest.id
    const bId = b.plugin.definition.manifest.id
    if (aId === bId) return 0
    return aId < bId ? -1 : 1
  })
  return entries.map(entry => entry.plugin)
}

/**
 * Renders every enabled plugin that declared this slot, ordered by manifest
 * `order` and then plugin id. Each plugin has its own error boundary, so one
 * failure never affects siblings or the surrounding screen.
 */
export function PluginSlot<S extends PluginSlotId>({
  id,
  context,
}: PluginSlotRendererProps<S>) {
  const host = usePluginHost()
  if (!host) return null

  const plugins = getPluginsForSlot(host.plugins, id)
  if (plugins.length === 0) return null

  return (
    <>
      {plugins.map(plugin => {
        const {manifest} = plugin.definition
        // The mapped lookup erases the slot/component correlation that JSX
        // checks against, so it is restored through the generic alias.
        const renderer: unknown = plugin.definition.slots[id]
        const Component = renderer as PluginSlotComponent<S> | undefined
        if (!Component) return null
        return (
          <PluginErrorBoundary
            key={manifest.id}
            pluginId={manifest.id}
            resetKey={host.resetKey}
            onFailure={host.reportFailure}
            onSuccess={host.reportSuccess}>
            <Component
              settings={plugin.settings}
              capabilities={plugin.capabilities}
              context={context}
              host={plugin.host}
            />
          </PluginErrorBoundary>
        )
      })}
    </>
  )
}
