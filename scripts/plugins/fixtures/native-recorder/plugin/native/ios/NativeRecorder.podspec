Pod::Spec.new do |s|
  s.name           = 'NativeRecorder'
  s.version        = '1.0.0'
  s.summary        = 'Native recorder plugin skeleton'
  s.description    = 'Native recorder plugin skeleton'
  s.author         = ''
  s.homepage       = ''
  s.platforms      = { :ios => '16.4' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = "**/*.{h,m,swift}"
end
