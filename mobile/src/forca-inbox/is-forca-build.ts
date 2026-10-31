import Constants from 'expo-constants'

// Forca: app.config.js sets extra.forcaUpdateChannel only when FORCA_APP=1.
export const isForcaBuild: boolean = Boolean(Constants.expoConfig?.extra?.forcaUpdateChannel)
