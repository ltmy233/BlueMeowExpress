// 动态 CSS 变量注入：根据主题方案实时生成背景渐变
import { useEffect, useMemo, useRef } from 'react'
import { useBackground } from '../context/BackgroundContext'
import { backgroundSchemes } from '../config/backgroundSchemes'

const DARK_BACKGROUND =
  'linear-gradient(135deg, #0f172a 0%, #1e293b 40%, #0f172a 100%)'

function currentShellTheme(): string | undefined {
  return document.querySelector<HTMLElement>('.app-shell')?.dataset.theme
}

function isDarkActive(): boolean {
  const theme = currentShellTheme()
  if (theme === 'dark') return true
  if (theme === 'light') return false
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
}

export default function DynamicStyles() {
  const { schemeId } = useBackground()
  const variablesRef = useRef<Record<string, string>>({})

  const variables = useMemo(() => {
    const scheme = backgroundSchemes[schemeId] || backgroundSchemes.aurora
    const dark = scheme.isDark || isDarkActive()
    const text = dark
      ? backgroundSchemes.midnight.textColors
      : scheme.textColors
    const neutral = dark
      ? backgroundSchemes.midnight.neutralColors
      : scheme.neutralColors
    const vars: Record<string, string> = {
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
    for (const tone of Object.keys(neutral)) {
      vars[`--color-neutral-${tone}`] = neutral[tone]
    }
    return vars
  }, [schemeId])

  useEffect(() => {
    variablesRef.current = variables
    const root = document.documentElement
    const apply = () => {
      const computed = variablesRef.current
      for (const [key, value] of Object.entries(computed)) {
        root.style.setProperty(key, value)
      }
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

    return () => {
      themeObserver?.disconnect()
      bodyObserver.disconnect()
      for (const key of Object.keys(variablesRef.current)) {
        root.style.removeProperty(key)
      }
    }
  }, [variables])

  return null
}