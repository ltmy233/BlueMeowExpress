// 附件校验：文件类型、大小限制
export const IMAGE_MAX_BYTES = 200 * 1024 * 1024
export const VIDEO_MAX_BYTES = 500 * 1024 * 1024

export type AttachmentKind = 'image' | 'video' | 'audio'

export function validateAttachment(file: Pick<File, 'type' | 'size'>): AttachmentKind {
  const kind = /^(image\/(jpeg|png|webp|gif))$/.test(file.type)
    ? 'image'
    : /^(video\/(mp4|webm))$/.test(file.type)
      ? 'video'
      : /^(audio\/(mpeg|mp4|webm|ogg|opus|wav|x-wav|aac|x-m4a))$/.test(file.type)
        ? 'audio'
        : null

  if (!kind) throw new Error('仅支持图片、视频和语音，主人请重新选择喵')
  const limit = kind === 'image' ? IMAGE_MAX_BYTES : VIDEO_MAX_BYTES
  if (file.size > limit) {
    throw new Error(kind === 'image' ? '图片不能超过 200 MB 喵' : '文件不能超过 500 MB 喵')
  }
  return kind
}

export function isValidEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
}
