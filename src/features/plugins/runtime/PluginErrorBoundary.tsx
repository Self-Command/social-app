import {Component, type ReactNode, useEffect} from 'react'

export const PLUGIN_RETRY_DELAY_MS = 1000

export type PluginErrorBoundaryProps = {
  pluginId: string
  children: ReactNode
  /**
   * Changing this key (new registry revision or account) clears the error and
   * lets the plugin render again.
   */
  resetKey: string
  retryDelayMs?: number
  onFailure: (pluginId: string, error: unknown) => void
  onSuccess: (pluginId: string) => void
}

type State = {
  hasError: boolean
}

/**
 * Isolates one plugin instance. On failure it renders nothing, reports the
 * failure, and retries once per second so the host can count consecutive
 * failures and trip the circuit breaker. A registry refresh (new resetKey)
 * clears the error immediately.
 */
export class PluginErrorBoundary extends Component<
  PluginErrorBoundaryProps,
  State
> {
  state: State = {hasError: false}
  private retryTimer: ReturnType<typeof setTimeout> | undefined

  static getDerivedStateFromError(): State {
    return {hasError: true}
  }

  componentDidCatch(error: Error) {
    this.props.onFailure(this.props.pluginId, error)
    this.scheduleRetry()
  }

  componentDidUpdate(previous: PluginErrorBoundaryProps) {
    if (previous.resetKey !== this.props.resetKey) {
      this.clearRetry()
      if (this.state.hasError) {
        this.setState({hasError: false})
      }
    }
  }

  componentWillUnmount() {
    this.clearRetry()
  }

  private scheduleRetry() {
    this.clearRetry()
    const resetKey = this.props.resetKey
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined
      if (this.props.resetKey === resetKey) {
        this.setState({hasError: false})
      }
    }, this.props.retryDelayMs ?? PLUGIN_RETRY_DELAY_MS)
  }

  private clearRetry() {
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer)
      this.retryTimer = undefined
    }
  }

  render() {
    if (this.state.hasError) {
      return null
    }
    return (
      <>
        {this.props.children}
        <PluginRenderSuccess
          pluginId={this.props.pluginId}
          onSuccess={this.props.onSuccess}
        />
      </>
    )
  }
}

function PluginRenderSuccess({
  pluginId,
  onSuccess,
}: {
  pluginId: string
  onSuccess: (pluginId: string) => void
}) {
  useEffect(() => {
    onSuccess(pluginId)
  }, [pluginId, onSuccess])
  return null
}
