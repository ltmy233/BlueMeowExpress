// 聊天偏好持久化：气泡颜色、墙纸、通知、输入方式等
import { readValue, storeValue } from './storage'

export interface ConversationAppearance {
  color: string
  wallpaper?: string
  dimWallpaper: boolean
  mentionNotifications: boolean
  customNotifications: boolean
}

export interface AppPreferences {
  fontSize: 'small' | 'normal' | 'large'
  linkPreviews: boolean
  systemEmoji: boolean
  enterToSend: boolean
  messageNotifications: boolean
  groupNotifications: boolean
  callNotifications: boolean
  notificationSound: boolean
  vibration: boolean
  readReceipts: boolean
  typingIndicators: boolean
  defaultDisappearingSeconds: number
  mobileDownloads: boolean
  wifiDownloads: boolean
  roamingDownloads: boolean
  mediaQuality: 'standard' | 'high'
  reduceCallData: boolean
  keepConnected: boolean
  storyViewReceipts: boolean
  conversations: Record<string, ConversationAppearance>
}

export const defaultPreferences: AppPreferences = {
  fontSize: 'normal',
  linkPreviews: true,
  systemEmoji: false,
  enterToSend: false,
  messageNotifications: true,
  groupNotifications: true,
  callNotifications: true,
  notificationSound: true,
  vibration: true,
  readReceipts: true,
  typingIndicators: true,
  defaultDisappearingSeconds: 0,
  mobileDownloads: true,
  wifiDownloads: true,
  roamingDownloads: false,
  mediaQuality: 'standard',
  reduceCallData: false,
  keepConnected: true,
  storyViewReceipts: true,
  conversations: {},
}

const key = (userId?: string) => `app.v1:${userId ?? 'anonymous'}`

export async function loadPreferences(userId?: string): Promise<AppPreferences> {
  const stored = await readValue<Partial<AppPreferences>>('preferences', key(userId))
  return {
    ...defaultPreferences,
    ...stored,
    conversations: stored?.conversations ?? {},
  }
}

export async function savePreferences(value: AppPreferences, userId?: string) {
  await storeValue('preferences', key(userId), value)
}

export function conversationAppearance(value: AppPreferences, conversationId: string): ConversationAppearance {
  return value.conversations[conversationId] ?? {
    color: '#ec4899',
    dimWallpaper: false,
    mentionNotifications: true,
    customNotifications: false,
  }
}
