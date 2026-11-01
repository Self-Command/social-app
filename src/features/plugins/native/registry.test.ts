import {NATIVE_PLUGIN_REGISTRY} from '../generated/native-registry'
import {type NativePluginRegistryEntry} from './registry'

describe('generated native plugin registry', () => {
  test('ships empty until the native assembly writes it', () => {
    expect(NATIVE_PLUGIN_REGISTRY).toEqual([])
  })

  test('entry shape carries the compiled package, modules and views', () => {
    const entry: NativePluginRegistryEntry = {
      id: 'com.selfcommand.voicecomment',
      version: '1.0.0',
      nativeApi: 1,
      packageName: '@community-plugins/voicecomment',
      modules: ['VoiceCommentModule'],
      views: [{name: 'VoiceRecorderView', heightMode: 'content'}],
    }
    expect(entry.packageName).toBe('@community-plugins/voicecomment')
    expect(entry.views[0]?.heightMode).toBe('content')
  })
})
