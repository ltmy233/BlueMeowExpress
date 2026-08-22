import 'fake-indexeddb/auto'
import { webcrypto } from 'node:crypto'

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })

if (!globalThis.btoa) {
  globalThis.btoa = (value) => Buffer.from(value, 'binary').toString('base64')
  globalThis.atob = (value) => Buffer.from(value, 'base64').toString('binary')
}
