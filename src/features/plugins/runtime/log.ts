import {Logger} from '#/logger'

/**
 * Plugin logs use the default context because the shared LogContext enum does
 * not include a plugin entry. The `feature` metadata distinguishes them.
 */
export const pluginLogger = Logger.create(Logger.Context.Default, {
  feature: 'plugins',
})

/**
 * Short, non-sensitive error description for logs. Stacks and arbitrary error
 * payloads are intentionally omitted.
 */
export function summarizeError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`.slice(0, 200)
  }
  if (typeof error === 'string') {
    return error.slice(0, 200)
  }
  return 'Unknown plugin error'
}
