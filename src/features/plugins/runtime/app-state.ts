import {AppState, type AppStateStatus} from 'react-native'

/**
 * Minimal AppState surface so the host can be driven deterministically in
 * tests without mocking React Native internals.
 */
export type PluginAppStateSource = {
  getCurrentState: () => AppStateStatus | null
  subscribe: (listener: (state: AppStateStatus) => void) => () => void
}

export const defaultPluginAppStateSource: PluginAppStateSource = {
  getCurrentState() {
    return (AppState.currentState ?? null) as AppStateStatus | null
  },
  subscribe(listener) {
    const subscription = AppState.addEventListener('change', listener)
    return () => subscription.remove()
  },
}
