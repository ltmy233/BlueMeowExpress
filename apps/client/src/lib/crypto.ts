// ECDH-P256 / AES-256-GCM 端到端加密：密钥生成、消息加解密、身份指纹
import { readValue, storeValue } from './storage'

const ALGORITHM = { name: 'ECDH', namedCurve: 'P-256' } as const
const IDENTITY_KEY = 'device-identity-v1'

export interface PublicIdentity {
  algorithm: 'ECDH-P256'
  publicKey: JsonWebKey
  fingerprint: string
}

export interface EncryptedEnvelope {
  version: 1
  algorithm: 'ECDH-P256/AES-256-GCM'
  ephemeralPublicKey: JsonWebKey
  iv: string
  ciphertext: string
}

interface StoredIdentity {
  privateKey: CryptoKey
  publicKey: CryptoKey
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function base64ToBytes(value: string) {
  const binary = atob(value)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

async function deriveKey(privateKey: CryptoKey, publicKey: CryptoKey) {
  const material = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: publicKey },
    privateKey,
    256,
  )
  return crypto.subtle.importKey('raw', material, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

export async function getOrCreateIdentity(): Promise<StoredIdentity> {
  const stored = await readValue<StoredIdentity>('identity', IDENTITY_KEY)
  if (stored) return stored
  const pair = (await crypto.subtle.generateKey(ALGORITHM, false, ['deriveBits'])) as CryptoKeyPair
  const identity = { privateKey: pair.privateKey, publicKey: pair.publicKey }
  await storeValue('identity', IDENTITY_KEY, identity)
  return identity
}

export async function exportPublicIdentity(): Promise<PublicIdentity> {
  const identity = await getOrCreateIdentity()
  const publicKey = await crypto.subtle.exportKey('jwk', identity.publicKey)
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(publicKey))),
  )
  const fingerprint = Array.from(digest.slice(0, 12), (byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .match(/.{1,4}/g)!
    .join(' ')
  return { algorithm: 'ECDH-P256', publicKey, fingerprint }
}

export async function encryptEnvelope(plaintext: string, recipientPublicJwk: JsonWebKey): Promise<EncryptedEnvelope> {
  const recipientKey = await crypto.subtle.importKey('jwk', recipientPublicJwk, ALGORITHM, false, [])
  const ephemeral = (await crypto.subtle.generateKey(ALGORITHM, true, ['deriveBits'])) as CryptoKeyPair
  const key = await deriveKey(ephemeral.privateKey, recipientKey)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext))
  return {
    version: 1,
    algorithm: 'ECDH-P256/AES-256-GCM',
    ephemeralPublicKey: await crypto.subtle.exportKey('jwk', ephemeral.publicKey),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  }
}

export async function decryptEnvelope(envelope: EncryptedEnvelope): Promise<string> {
  if (envelope.version !== 1 || envelope.algorithm !== 'ECDH-P256/AES-256-GCM') {
    throw new Error('不支持的加密信封版本')
  }
  const identity = await getOrCreateIdentity()
  const ephemeralKey = await crypto.subtle.importKey('jwk', envelope.ephemeralPublicKey, ALGORITHM, false, [])
  const key = await deriveKey(identity.privateKey, ephemeralKey)
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(envelope.iv) },
    key,
    base64ToBytes(envelope.ciphertext),
  )
  return new TextDecoder().decode(plaintext)
}
