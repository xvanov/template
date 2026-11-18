# The glasses module (iOS). Only installed when GLASSES_ENABLED=true: the
# config plugin otherwise excludes it from autolinking (../plugin/with-glasses.js).
#
# Meta ships the Device Access Toolkit as a Swift Package only, so it is added
# with React Native's spm_dependency helper (applied in the Podfile's
# post_install). The version and whether MockDeviceKit is linked come from
# ios/Podfile.properties.json, written by the config plugin.
require 'json'

react_native_pods = File.join(
  File.dirname(`node --print "require.resolve('react-native/package.json')"`.strip),
  'scripts', 'react_native_pods'
)
require react_native_pods

podfile_properties = begin
  JSON.parse(File.read(File.join(Pod::Config.instance.installation_root.to_s, 'Podfile.properties.json')))
rescue StandardError
  {}
end
dat_version = podfile_properties['glasses.datVersion'] || '1.0.1'
mock_device = podfile_properties['glasses.mockDevice'] == 'true'

Pod::Spec.new do |s|
  s.name           = 'Glasses'
  s.version        = '1.0.0'
  s.summary        = 'Meta Wearables Device Access Toolkit, wrapped as an Expo module.'
  s.description    = s.summary
  s.license        = 'UNLICENSED'
  s.author         = ''
  s.homepage       = 'https://wearables.developer.meta.com/'
  # The DAT supports iOS 17.2+ (Xcode 26.4+, Swift 6.3+).
  s.platforms      = { :ios => '17.2' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  products = ['MWDATCore', 'MWDATCamera']
  products << 'MWDATMockDevice' if mock_device
  spm_dependency(s,
    url: 'https://github.com/facebook/meta-wearables-dat-ios',
    requirement: { kind: 'exactVersion', version: dat_version },
    products: products
  )

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
  s.source_files = '**/*.swift'
end
