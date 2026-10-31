// Bare expo-notifications defaults to sandbox entitlements while non-dev push-token.ts reports production, silently losing TestFlight/App Store pushes.
// Derive APNs mode from release workflow env; Expo still supplies app.json, including Fastlane version/buildNumber rewrites, for everything else.
const APS_ENVIRONMENT =
  process.env.ORCA_IOS_APS_ENVIRONMENT === 'production' ? 'production' : 'development'

// Forca: FORCA_APP=1 builds the Forca app. It has its own Android package, so it installs beside the official Orca app.
// The official Firebase file is tied to the Orca package, so a Forca build has no push notifications.
const FORCA_APP = process.env.FORCA_APP === '1'

function forcaOverrides(config) {
  if (!FORCA_APP) return {}
  const { googleServicesFile: _official, ...android } = config.android ?? {}
  // The Forca workflow sets the version from its run number. The app version is not part of the host protocol.
  const version = process.env.FORCA_VERSION ?? config.version
  const versionCode = Number(process.env.FORCA_VERSION_CODE ?? android.versionCode)
  return {
    name: 'Forca',
    scheme: 'forca',
    version,
    android: { ...android, package: 'com.ykgkaira.forca', versionCode },
    extra: {
      ...config.extra,
      forcaUpdateChannel: {
        repoApi: 'https://api.github.com/repos/ykgkaira/orca',
        tagPrefix: 'forca-android-v'
      }
    }
  }
}

module.exports = ({ config }) => ({
  ...config,
  ...forcaOverrides(config),
  // `expo run` installs a dev-client build cached for the current native fingerprint instead of
  // rebuilding; scripts/native-client.mjs populates the cache.
  buildCacheProvider: { plugin: './scripts/native-build-cache.cjs' },
  ios: {
    ...config.ios,
    entitlements: { ...config.ios?.entitlements, 'aps-environment': APS_ENVIRONMENT }
  },
  plugins: (config.plugins ?? []).map((plugin) =>
    plugin === 'expo-notifications'
      ? [
          'expo-notifications',
          {
            enableBackgroundRemoteNotifications: true,
            mode: APS_ENVIRONMENT,
            icon: './assets/notification-icon.png'
          }
        ]
      : plugin
  )
})
