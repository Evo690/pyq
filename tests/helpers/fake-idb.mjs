/**
 * Test-only in-memory IndexedDB implementing just the surface the offline
 * cache uses (open/transaction/objectStore get/put/delete/getAll).
 */
/* -------------------------------------------------------------------------- */
/* Minimal in-memory IndexedDB (only what the cache module uses)               */
/* -------------------------------------------------------------------------- */

export class FakeRequest {
  constructor() {
    this.result = undefined;
    this.error = null;
    this.onsuccess = null;
    this.onerror = null;
    this.onblocked = null;
  }

  succeed(value) {
    this.result = value;
    queueMicrotask(() => this.onsuccess?.({ target: this }));
  }
}

class FakeObjectStore {
  constructor(name, records) {
    this.name = name;
    this.records = records;
  }

  get(key) {
    const request = new FakeRequest();
    request.succeed(this.records.get(key));
    return request;
  }

  put(value) {
    this.records.set(value[this.keyPath()], value);
    const request = new FakeRequest();
    request.succeed(value[this.keyPath()]);
    return request;
  }

  delete(key) {
    this.records.delete(key);
    const request = new FakeRequest();
    request.succeed(undefined);
    return request;
  }

  clear() {
    this.records.clear();
    const request = new FakeRequest();
    request.succeed(undefined);
    return request;
  }

  getAll() {
    const request = new FakeRequest();
    request.succeed([...this.records.values()]);
    return request;
  }

  keyPath() {
    return this.name === "images" ? "url" : "key";
  }
}

export function createFakeIndexedDb() {
  const stores = new Map([
    ["papers", new Map()],
    ["images", new Map()],
    ["meta", new Map()],
  ]);
  const db = {
    objectStoreNames: { contains: (name) => stores.has(name) },
    createObjectStore: (name) => {
      if (!stores.has(name)) stores.set(name, new Map());
    },
    transaction: () => {
      const transaction = {
        error: null,
        objectStore: (name) => new FakeObjectStore(name, stores.get(name)),
        oncomplete: null,
        onerror: null,
        onabort: null,
      };
      queueMicrotask(() => transaction.oncomplete?.());
      return transaction;
    },
  };
  return {
    stores,
    open() {
      const request = new FakeRequest();
      request.result = db;
      queueMicrotask(() => request.onsuccess?.({ target: request }));
      return request;
    },
  };
}

export function createMemoryStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

export const SVG_PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
