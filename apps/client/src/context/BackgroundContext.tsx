// 背景主题上下文：全局主题方案状态管理与切换
import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { backgroundSchemes, defaultScheme, getSchemeById, type BackgroundScheme } from '../config/backgroundSchemes'

interface BackgroundState {
  schemeId: string
  customCss: string
}

interface BackgroundContextValue {
  scheme: BackgroundScheme
  schemeId: string
  changeScheme: (schemeId: string) => void
  resetToDefault: () => void
  getCssVariables: () => Record<string, string>
  getBackgroundStyle: () => React.CSSProperties
  schemes: BackgroundScheme[]
}

const BackgroundContext = createContext<BackgroundContextValue | null>(null)

const STORAGE_KEY = 'auroraqua_background'

function loadStored(): BackgroundState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as { schemeId?: string; customCss?: string }
      if (parsed.schemeId && backgroundSchemes[parsed.schemeId]) {
        return { schemeId: parsed.schemeId, customCss: parsed.customCss || '' }
      }
    }
  } catch {
    // ignore corrupted storage
  }
  return { schemeId: defaultScheme, customCss: '' }
}

export function BackgroundProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<BackgroundState>(loadStored)

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    } catch {
      // storage may be unavailable; theme still applies for this session
    }
  }, [state])

  const changeScheme = useCallback((schemeId: string) => {
    if (backgroundSchemes[schemeId]) {
      setState((prev) => ({ schemeId, customCss: prev.customCss }))
    }
  }, [])

  const resetToDefault = useCallback(() => {
    setState({ schemeId: defaultScheme, customCss: '' })
  }, [])

  const getCssVariables = useCallback((): Record<string, string> => {
    const scheme = getSchemeById(state.schemeId)
    const text = scheme.textColors
    return {
      '--bg-primary': scheme.background,
      '--color-primary': scheme.primaryColor,
      '--color-secondary': scheme.secondaryColor,
      '--color-accent': scheme.accentColor,
      '--color-neutral-50': scheme.neutralColors['50'] ?? '#faf5ff',
      '--color-neutral-100': scheme.neutralColors['100'] ?? '#f3e8ff',
      '--color-neutral-200': scheme.neutralColors['200'] ?? '#e9d5ff',
      '--color-neutral-300': scheme.neutralColors['300'] ?? '#d8b4fe',
      '--color-neutral-400': scheme.neutralColors['400'] ?? '#c084fc',
      '--color-neutral-500': scheme.neutralColors['500'] ?? '#a855f7',
      '--color-neutral-600': scheme.neutralColors['600'] ?? '#9333ea',
      '--color-neutral-700': scheme.neutralColors['700'] ?? '#7e22ce',
      '--color-neutral-800': scheme.neutralColors['800'] ?? '#6b21a8',
      '--color-neutral-900': scheme.neutralColors['900'] ?? '#581c87',
      '--text-heading': text.heading,
      '--text-body': text.body,
      '--text-secondary': text.secondary,
      '--text-muted': text.muted,
      '--text-glass-heading': text.glassHeading,
      '--text-glass-body': text.glassBody,
      '--text-glass-muted': text.glassMuted,
      '--is-dark': scheme.isDark ? 'true' : 'false',
    }
  }, [state.schemeId])

  const getBackgroundStyle = useCallback((): React.CSSProperties => {
    if (state.customCss) {
      try {
        const style: Record<string, string> = {}
        for (const part of state.customCss.split(';')) {
          const [key, value] = part.split(':').map((segment) => segment.trim())
          if (key && value) {
            const camelKey = key.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase())
            style[camelKey] = value
          }
        }
        return style
      } catch {
        return { background: getSchemeById(state.schemeId).background }
      }
    }
    return { background: getSchemeById(state.schemeId).background }
  }, [state.customCss, state.schemeId])

  return (
    <BackgroundContext.Provider
      value={{
        scheme: getSchemeById(state.schemeId),
        schemeId: state.schemeId,
        changeScheme,
        resetToDefault,
        getCssVariables,
        getBackgroundStyle,
        schemes: Object.values(backgroundSchemes),
      }}
    >
      {children}
    </BackgroundContext.Provider>
  )
}

export function useBackground(): BackgroundContextValue {
  const context = useContext(BackgroundContext)
  if (!context) throw new Error('useBackground must be used within a BackgroundProvider')
  return context
}