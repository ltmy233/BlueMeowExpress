import { beforeEach, describe, expect, it } from 'vitest'
import { clearStore } from './storage'
import { decryptEnvelope, encryptEnvelope, exportPublicIdentity } from './crypto'

describe('encrypted envelopes', () => {
  beforeEach(async () => clearStore('identity'))

  it('encrypts to the local identity and decrypts the authenticated payload', async () => {
    const identity = await exportPublicIdentity()
    const envelope = await encryptEnvelope('主人，密文已送达喵', identity.publicKey)

    expect(envelope.algorithm).toBe('ECDH-P256/AES-256-GCM')
    expect(envelope.ciphertext).not.toContain('密文已送达')
    await expect(decryptEnvelope(envelope)).resolves.toBe('主人，密文已送达喵')
  })

  it('rejects tampered ciphertext', async () => {
    const identity = await exportPublicIdentity()
    const envelope = await encryptEnvelope('authenticated', identity.publicKey)
    const last = envelope.ciphertext.at(-1)
    envelope.ciphertext = `${envelope.ciphertext.slice(0, -1)}${last === 'A' ? 'B' : 'A'}`

    await expect(decryptEnvelope(envelope)).rejects.toThrow()
  })

  it('keeps a stable public fingerprint for the stored device key', async () => {
    const first = await exportPublicIdentity()
    const second = await exportPublicIdentity()
    expect(second.fingerprint).toBe(first.fingerprint)
  })
})
