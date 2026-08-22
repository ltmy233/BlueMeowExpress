// 未读计数持久化：按会话保存和读取未读数
import { Preferences } from '@capacitor/preferences'

const key = (userId: string) => `lanmiao.unread.${userId}.v1`

export async function loadUnread(userId: string): Promise<Record<string, number>> {
  const { value } = await Preferences.get({ key: key(userId) })
  if (!value) return {}
  try { return JSON.parse(value) as Record<string, number> } catch { return {} }
}

export async function saveUnread(userId: string, unread: Record<string, number>) {
  await Preferences.set({ key: key(userId), value: JSON.stringify(unread) })
}
