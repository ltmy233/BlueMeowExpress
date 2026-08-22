// 外观设置：主题模式、背景图、模糊效果
import { readValue, storeValue } from './storage'

export type ThemeMode = 'system' | 'light' | 'dark'

export interface AppearanceSettings {
  theme: ThemeMode
  background?: Blob
  blurEnabled: boolean
  blurStrength: number
}

const KEY = 'app.v1'
const defaults: AppearanceSettings = {
  theme: 'system',
  blurEnabled: false,
  blurStrength: 8,
}

export async function loadAppearance(): Promise<AppearanceSettings> {
  const stored = await readValue<Partial<AppearanceSettings>>('appearance', KEY)
  return {
    ...defaults,
    ...stored,
    theme: ['system', 'light', 'dark'].includes(stored?.theme ?? '') ? stored!.theme as ThemeMode : 'system',
    blurStrength: Math.min(24, Math.max(0, Number(stored?.blurStrength ?? defaults.blurStrength))),
  }
}

export async function saveAppearance(value: AppearanceSettings) {
  await storeValue('appearance', KEY, value)
}
