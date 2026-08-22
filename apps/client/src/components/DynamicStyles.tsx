// 动态 CSS 变量注入：根据主题方案实时生成背景渐变
import { useEffect } from 'react'
import { useBackground } from '../context/BackgroundContext'
import { backgroundSchemes } from '../config/backgroundSchemes'

const DARK_BACKGROUND =
  'linear-gradient(135deg, #0f172a 0%, #1e293b 40%, #0f172a 100%)'

function currentShellTheme(): string | undefined {
  return document.querySelector<HTMLElement>('.app-shell')?.dataset.theme
}

function isDarkActive(theme = currentShellTheme()): boolean {
  if (theme === 'dark') return true
  if (theme === 'light') return false
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
}

export default function DynamicStyles() {
  const { schemeId } = useBackground()

  useEffect(() => {
    const scheme = backgroundSchemes[schemeId] || backgroundSchemes.aurora
    const root = document.documentElement
    const apply = () => {
      const dark = scheme.isDark || isDarkActive()
      const text = dark ? backgroundSchemes.midnight.textColors : scheme.textColors
      const neutral = dark ? backgroundSchemes.midnight.neutralColors : scheme.neutralColors
      const variables: Record<string, string> = {
        '--bg-primary': dark ? DARK_BACKGROUND : scheme.background,
        '--color-primary': scheme.primaryColor,
        '--color-secondary': scheme.secondaryColor,
        '--color-accent': scheme.accentColor,
        '--text-heading': text.heading,
        '--text-body': text.body,
        '--text-secondary': text.secondary,
        '--text-muted': text.muted,
        '--text-glass-heading': text.glassHeading,
        '--text-glass-body': text.glassBody,
        '--text-glass-muted': text.glassMuted,
        '--is-dark': String(dark),
      }
      for (const tone of Object.keys(neutral)) variables[`--color-neutral-${tone}`] = neutral[tone]
      for (const [key, value] of Object.entries(variables)) {
        root.style.setProperty(key, value)
      }
      const systemUi = (window as Window & {
        LanMiaoSystemUi?: {
          getSafeInsets?: () => string
          setDarkMode: (dark: boolean) => void
        }
      }).LanMiaoSystemUi
      try {
        const insets = JSON.parse(systemUi?.getSafeInsets?.() ?? '{}') as Record<string, unknown>
        for (const side of ['top', 'right', 'bottom', 'left']) {
          const value = Number(insets[side])
          if (Number.isFinite(value) && value >= 0) root.style.setProperty(`--native-safe-${side}`, `${value}px`)
        }
      } catch {
        // CSS env() remains the fallback outside the native Android shell.
      }
      systemUi?.setDarkMode(dark)
    }
    apply()

    const shell = document.querySelector<HTMLElement>('.app-shell')
    let themeObserver: MutationObserver | null = null
    if (shell) {
      themeObserver = new MutationObserver(apply)
      themeObserver.observe(shell, { attributes: true, attributeFilter: ['data-theme'] })
    }
    const bodyObserver = new MutationObserver(() => {
      const found = document.querySelector<HTMLElement>('.app-shell')
      if (found && found !== shell) {
        bodyObserver.disconnect()
        themeObserver?.disconnect()
        themeObserver = new MutationObserver(apply)
        themeObserver.observe(found, { attributes: true, attributeFilter: ['data-theme'] })
        apply()
      }
    })
    bodyObserver.observe(document.body, { childList: true, subtree: true })
    const systemTheme = window.matchMedia?.('(prefers-color-scheme: dark)')
    systemTheme?.addEventListener?.('change', apply)

    return () => {
      themeObserver?.disconnect()
      bodyObserver.disconnect()
      systemTheme?.removeEventListener?.('change', apply)
    }
  }, [schemeId])

  return null
}
