// 外观设置：主题模式、背景图、模糊效果
import { readValue, storeValue } from './storage'

export type ThemeMode = 'system' | 'light' | 'dark'

export interface AppearanceSettings {
  theme: ThemeMode
  background?: Blob
  blurEnabled: boolean
  blurStrength: number
}

type StoredAppearance = Partial<AppearanceSettings> & { version?: number }

const KEY = 'app.v1'
const defaults: AppearanceSettings = {
  theme: 'light',
  blurEnabled: false,
  blurStrength: 8,
}

export async function loadAppearance(): Promise<AppearanceSettings> {
  const stored = await readValue<StoredAppearance>('appearance', KEY)
  const value: AppearanceSettings = {
    ...defaults,
    ...stored,
    theme: stored?.version !== 2 && stored?.theme === 'system'
      ? 'light'
      : ['system', 'light', 'dark'].includes(stored?.theme ?? '') ? stored!.theme as ThemeMode : defaults.theme,
    blurStrength: Math.min(24, Math.max(0, Number(stored?.blurStrength ?? defaults.blurStrength))),
  }
  if (stored?.version !== 2) await storeValue('appearance', KEY, { ...value, version: 2 })
  return value
}

export async function saveAppearance(value: AppearanceSettings) {
  await storeValue('appearance', KEY, { ...value, version: 2 })
}
