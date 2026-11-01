import {requireNativeModule} from 'expo-modules-core'

export type NativeRecorderModuleEvents = {
  onRecordingFinished: (event: {recordingId: string}) => void
}

export type NativeRecorderModule = {
  isAvailable: () => Promise<boolean>
}

export const NativeRecorder =
  requireNativeModule<NativeRecorderModule>('NativeRecorder')
