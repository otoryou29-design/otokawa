import { initializeApp } from 'firebase/app'
import { getDatabase, ref, onValue, set, update, push, remove, get } from 'firebase/database'

const firebaseConfig = {
  apiKey: "AIzaSyCFhWp8i_S0RqukypywfpoKZKKdlSDvzxM",
  authDomain: "otokawa-5889b.firebaseapp.com",
  databaseURL: "https://otokawa-5889b-default-rtdb.firebaseio.com",
  projectId: "otokawa-5889b",
  storageBucket: "otokawa-5889b.firebasestorage.app",
  messagingSenderId: "816114985102",
  appId: "1:816114985102:web:004bc44b317f84b67501df",
  measurementId: "G-G6V9RDY7GB"
}

const app = initializeApp(firebaseConfig)
export const db = getDatabase(app)

// ── ショートカットヘルパー
export const dbRef   = (path) => ref(db, path)
export const dbSet   = (path, val) => set(ref(db, path), val)
export const dbUpdate = (path, val) => update(ref(db, path), val)
export const dbPush  = (path, val) => push(ref(db, path), val)
export const dbRemove = (path) => remove(ref(db, path))
export const dbGet   = (path) => get(ref(db, path))

// リスナー登録（コンポーネントのuseEffectで使う）
// 返り値はunsubscribe関数
export const dbListen = (path, callback) => {
  const r = ref(db, path)
  const unsub = onValue(r, (snap) => {
    callback(snap.val())
  })
  return unsub
}

// DB初期化チェック：パスにデータがなければdefaultを書き込む
export const initIfEmpty = async (path, defaultVal) => {
  const snap = await dbGet(path)
  if (!snap.exists()) {
    await dbSet(path, defaultVal)
  }
}

