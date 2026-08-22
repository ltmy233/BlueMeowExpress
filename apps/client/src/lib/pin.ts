// PIN 锁：设置、校验、锁定状态管理
import { deleteValue, readValue, storeValue } from './storage'

const PIN_KEY = 'app-pin'
const LOCKED_AT_KEY = 'locked-at'

export async function getPinHash(): Promise<string | undefined> {
  return await readValue<string>('security', PIN_KEY)
}

export async function setPin(pin: string): Promise<void> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`lanmiao-pin:${pin}`))
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
  await storeValue('security', PIN_KEY, hash)
}

export async function clearPin(): Promise<void> {
  await deleteValue('security', PIN_KEY)
}

export async function verifyPin(pin: string): Promise<boolean> {
  const expected = await getPinHash()
  if (!expected) return true
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`lanmiao-pin:${pin}`))
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
  return hash === expected
}

export async function getLockedAt(): Promise<number | undefined> {
  return await readValue<number>('security', LOCKED_AT_KEY)
}

export async function setLockedAt(value: number): Promise<void> {
  await storeValue('security', LOCKED_AT_KEY, value)
}
