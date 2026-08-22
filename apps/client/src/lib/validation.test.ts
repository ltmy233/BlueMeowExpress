import { describe, expect, it } from 'vitest'
import { IMAGE_MAX_BYTES, VIDEO_MAX_BYTES, isValidEmail, validateAttachment } from './validation'

describe('validateAttachment', () => {
  it('accepts image and video files at their size limits', () => {
    expect(validateAttachment({ type: 'image/jpeg', size: IMAGE_MAX_BYTES })).toBe('image')
    expect(validateAttachment({ type: 'video/mp4', size: VIDEO_MAX_BYTES })).toBe('video')
  })

  it('rejects oversized and unsupported files', () => {
    expect(() => validateAttachment({ type: 'image/png', size: IMAGE_MAX_BYTES + 1 })).toThrow('200 MB')
    expect(() => validateAttachment({ type: 'video/mp4', size: VIDEO_MAX_BYTES + 1 })).toThrow('500 MB')
    expect(() => validateAttachment({ type: 'application/pdf', size: 100 })).toThrow('仅支持')
  })
})

describe('isValidEmail', () => {
  it('validates basic mailbox structure', () => {
    expect(isValidEmail('owner@example.com')).toBe(true)
    expect(isValidEmail('owner@localhost')).toBe(false)
    expect(isValidEmail('not an email')).toBe(false)
  })
})
