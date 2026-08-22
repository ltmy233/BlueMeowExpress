// IndexedDB 存储：身份密钥、附件缓存、消息、外观偏好
const DB_NAME = 'lanmiao-client'
const DB_VERSION = 5
type Store = 'identity' | 'attachments' | 'messages' | 'appearance' | 'security' | 'preferences'

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains('identity')) db.createObjectStore('identity')
      if (!db.objectStoreNames.contains('attachments')) db.createObjectStore('attachments')
      if (!db.objectStoreNames.contains('messages')) db.createObjectStore('messages')
      if (!db.objectStoreNames.contains('appearance')) db.createObjectStore('appearance')
      if (!db.objectStoreNames.contains('security')) db.createObjectStore('security')
      if (!db.objectStoreNames.contains('preferences')) db.createObjectStore('preferences')
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export async function storeValue(store: Store, key: string, value: unknown) {
  const db = await openDatabase()
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(store, 'readwrite')
    transaction.objectStore(store).put(value, key)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
  })
  db.close()
}

export async function readValue<T>(store: Store, key: string): Promise<T | undefined> {
  const db = await openDatabase()
  const result = await new Promise<T | undefined>((resolve, reject) => {
    const request = db.transaction(store).objectStore(store).get(key)
    request.onsuccess = () => resolve(request.result as T | undefined)
    request.onerror = () => reject(request.error)
  })
  db.close()
  return result
}

export async function deleteValue(store: Store, key: string) {
  const db = await openDatabase()
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(store, 'readwrite')
    transaction.objectStore(store).delete(key)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
  })
  db.close()
}

export async function clearStore(store: Store) {
  const db = await openDatabase()
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(store, 'readwrite')
    transaction.objectStore(store).clear()
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
  })
  db.close()
}

export async function countStore(store: Store) {
  const db = await openDatabase()
  const count = await new Promise<number>((resolve, reject) => {
    const request = db.transaction(store).objectStore(store).count()
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  db.close()
  return count
}
