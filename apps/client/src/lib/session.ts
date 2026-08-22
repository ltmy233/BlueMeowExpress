// 登录会话持久化：通过 Capacitor Preferences 存取 JWT + 用户信息
import { Preferences } from '@capacitor/preferences'
import type { Session } from '../api/client'

const SESSION_KEY = 'lanmiao.session.v1'

export async function saveSession(session: Session) {
  await Preferences.set({ key: SESSION_KEY, value: JSON.stringify(session) })
}

export async function loadSession(): Promise<Session | null> {
  const { value } = await Preferences.get({ key: SESSION_KEY })
  if (!value) return null
  try { return JSON.parse(value) as Session } catch { await clearSession(); return null }
}

export async function clearSession() {
  await Preferences.remove({ key: SESSION_KEY })
}
