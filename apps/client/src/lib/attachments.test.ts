import { beforeEach, describe, expect, it } from 'vitest'
import { clearAttachmentCache } from './attachments'
import { clearStore, countStore, readValue, storeValue } from './storage'

describe('attachment cache', () => {
  beforeEach(async () => {
    await clearStore('attachments')
    await clearStore('identity')
  })

  it('clears every attachment without deleting identity data', async () => {
    await storeValue('attachments', 'first', { cached: true })
    await storeValue('attachments', 'second', { cached: true })
    await storeValue('identity', 'session', { accessToken: 'kept' })

    await clearAttachmentCache()

    expect(await countStore('attachments')).toBe(0)
    expect(await readValue('identity', 'session')).toEqual({ accessToken: 'kept' })
  })
})
