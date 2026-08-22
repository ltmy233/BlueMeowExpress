import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClient } from './client'

const ok = (body?: unknown) => Promise.resolve(new Response(body === undefined ? null : JSON.stringify(body), {
  status: body === undefined ? 204 : 200,
  headers: { 'Content-Type': 'application/json' },
}))

describe('ApiClient contracts', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn(() => ok())))

  it('uses a password and identity for login without requesting a login email code', async () => {
    const api = new ApiClient('https://api.example.test')
    const identity = { algorithm: 'ECDH-P256' as const, publicKey: { kty: 'EC' }, fingerprint: 'abcd' }
    vi.mocked(fetch).mockImplementationOnce(() => ok({ accessToken: 'a', user: {} }))
    await api.login({ email: 'owner@example.test', password: 'password123', identity })
    expect(fetch).toHaveBeenCalledWith('https://api.example.test/auth/login', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ email: 'owner@example.test', password: 'password123', identity }),
    }))
  })

  it('requests email codes only for registration', async () => {
    const api = new ApiClient('/api/v1')
    await api.requestRegistrationCode('owner@example.test')
    expect(fetch).toHaveBeenCalledWith('/api/v1/auth/email-code', expect.objectContaining({
      body: JSON.stringify({ email: 'owner@example.test', purpose: 'register' }),
    }))
  })

  it('sends bearer authorization and versioned disclaimer acceptance', async () => {
    const api = new ApiClient('/api/v1', 'access-token')
    await api.acceptDisclaimer('2026-08')
    expect(fetch).toHaveBeenCalledWith('/api/v1/disclaimer/accept', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ version: '2026-08' }),
      headers: expect.objectContaining({ Authorization: 'Bearer access-token' }),
    }))
  })

  it('redeems the visible platform-admin state through the profile endpoint', async () => {
    const api = new ApiClient('/api/v1', 'access-token')
    vi.mocked(fetch).mockImplementationOnce(() => ok({ role: 'platform-admin' }))
    await api.redeemPlatformAdmin('LTMY-MOD-ONE-TIME')
    expect(fetch).toHaveBeenCalledWith('/api/v1/platform-admin/redeem', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ code: 'LTMY-MOD-ONE-TIME' }),
    }))
  })

  it('unwraps the exact server list wrappers and parses the error property', async () => {
    const api = new ApiClient('/api', 'access-token')
    vi.mocked(fetch).mockImplementationOnce(() => ok({ conversations: [{ id: 'g-1' }] }))
    await expect(api.listConversations()).resolves.toEqual([{ id: 'g-1' }])
    vi.mocked(fetch).mockImplementationOnce(() => Promise.resolve(new Response(JSON.stringify({ error: 'denied' }), { status: 403, headers: { 'Content-Type': 'application/json' } })))
    await expect(api.me()).rejects.toThrow('denied')
  })

  it('converts browser fetch failures into a readable network error', async () => {
    const api = new ApiClient('/api')
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await expect(api.getDisclaimer()).rejects.toMatchObject({
      message: '网络连接失败，请检查网络后重试',
      code: 'NETWORK',
    })
  })

  it('normalizes account ban expiry from milliseconds, seconds and ISO text', async () => {
    const api = new ApiClient('/api', 'access-token')
    const notices: Array<{ bannedUntil?: number | null; reason: string }> = []
    api.setAccountBannedHandler((notice) => notices.push(notice))
    const values = [1786910400000, 1786910400, '2026-08-16T20:00:00.000Z']
    for (const expiresAt of values) {
      vi.mocked(fetch).mockImplementationOnce(() => Promise.resolve(new Response(JSON.stringify({ error: '账号已被封禁', code: 'ACCOUNT_BANNED', expiresAt, reason: '测试一天封禁' }), { status: 403, headers: { 'Content-Type': 'application/json' } })))
      await expect(api.me()).rejects.toThrow('账号已被封禁')
    }
    expect(notices).toEqual([
      { bannedUntil: 1786910400000, reason: '测试一天封禁' },
      { bannedUntil: 1786910400000, reason: '测试一天封禁' },
      { bannedUntil: 1786910400000, reason: '测试一天封禁' },
    ])
  })

  it('uploads attachments as binary files without base64 expansion', async () => {
    const open = vi.fn()
    const setRequestHeader = vi.fn()
    const send = vi.fn(function (this: { status: number; responseText: string; onload?: () => void }, body: unknown) {
      expect(body).toBe(file)
      this.status = 201
      this.responseText = JSON.stringify({ id: 'attachment-id', name: file.name, mime: file.type, size: file.size })
      this.onload?.()
    })
    class MockXhr {
      status = 0
      responseText = ''
      upload: { onprogress?: (event: ProgressEvent) => void } = {}
      onerror?: () => void
      onload?: () => void
      open = open
      setRequestHeader = setRequestHeader
      send = send
    }
    vi.stubGlobal('XMLHttpRequest', MockXhr)
    const file = new File(['binary-content'], '照片.png', { type: 'image/png' })
    const api = new ApiClient('/api/v1', 'access-token')

    await expect(api.uploadAttachment(file, 'g-1')).resolves.toMatchObject({ id: 'attachment-id' })
    expect(open).toHaveBeenCalledWith('POST', '/api/v1/attachments')
    expect(setRequestHeader).toHaveBeenCalledWith('Content-Type', 'image/png')
    expect(setRequestHeader).toHaveBeenCalledWith('X-Attachment-Name', encodeURIComponent(file.name))
  })
})
