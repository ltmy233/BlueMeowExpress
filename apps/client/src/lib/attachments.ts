// 附件本地缓存：IndexedDB 存取已下载的媒体文件
import type { AttachmentMeta } from '../types'
import { clearStore, countStore, deleteValue, readValue, storeValue } from './storage'
import { validateAttachment } from './validation'

interface CachedAttachment {
  blob: Blob
  meta: Omit<AttachmentMeta, 'localUrl'>
  cachedAt: number
}

export async function cacheAttachment(file: File): Promise<AttachmentMeta> {
  validateAttachment(file)
  const id = crypto.randomUUID()
  const meta = { id, name: file.name, mime: file.type, size: file.size }
  await storeValue('attachments', id, { blob: file, meta, cachedAt: Date.now() } satisfies CachedAttachment)
  return { ...meta, localUrl: URL.createObjectURL(file) }
}

export async function cacheServerAttachment(meta: AttachmentMeta, blob: Blob): Promise<AttachmentMeta> {
  const normalized = { id: meta.id, name: meta.name, mime: meta.mime || blob.type, size: meta.size || blob.size }
  await storeValue('attachments', meta.id, { blob, meta: normalized, cachedAt: Date.now() } satisfies CachedAttachment)
  return { ...normalized, localUrl: URL.createObjectURL(blob) }
}

export async function loadCachedAttachment(id: string) {
  const cached = await readValue<CachedAttachment>('attachments', id)
  if (!cached) return undefined
  return { ...cached.meta, localUrl: URL.createObjectURL(cached.blob) }
}

export const removeCachedAttachment = (id: string) => deleteValue('attachments', id)
export async function clearAttachmentCache() {
  await clearStore('attachments')
  if (await countStore('attachments')) throw new Error('本地缓存未完全清理')
}
