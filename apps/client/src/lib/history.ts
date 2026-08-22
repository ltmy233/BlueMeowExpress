// 聊天记录本地缓存：IndexedDB 读写、合并、清除
import type { ChatMessage } from '../types'
import { deleteValue, readValue, storeValue } from './storage'

export async function loadHistory(conversationId: string): Promise<ChatMessage[]> {
  return await readValue<ChatMessage[]>('messages', conversationId) ?? []
}

export async function removeHistory(conversationId: string): Promise<void> {
  await deleteValue('messages', conversationId)
}

export async function appendHistory(conversationId: string, message: ChatMessage): Promise<void> {
  const current = await loadHistory(conversationId)
  const next = [...current.filter(item => item.id !== message.id), message].sort((a, b) => a.sentAt.localeCompare(b.sentAt))
  await storeValue('messages', conversationId, next)
}

export async function tombstoneHistory(conversationId: string, messageId: string): Promise<void> {
  const current = await loadHistory(conversationId)
  await storeValue('messages', conversationId, current.map(item => item.id === messageId ? { ...item, body: '此消息已由群组治理移除', governance: true } : item))
}

export async function recallHistory(conversationId: string, messageId: string): Promise<void> {
  const current = await loadHistory(conversationId)
  await storeValue('messages', conversationId, current.map(item => item.id === messageId ? { ...item, body: '', attachment: undefined, quote: undefined, recalled: true } : item))
}
