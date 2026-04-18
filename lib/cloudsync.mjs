// Upstash Redis-backed state sync.
//
// Each tournament's full state lives at a single Redis key
// `cc:room:<roomId>`. Every mutation writes the new state and publishes
// an empty notification on `cc:chan:<roomId>`. Subscribers listen via
// Server-Sent Events and fetch the updated state on any event. The
// published body itself is ignored — the GET is the source of truth,
// which keeps payloads tiny and avoids SSE length limits.
//
// Deletion is just a flag in the state: { deleted: true }. The
// subscriber checks it and kicks the user back to the home page.

import {
  UPSTASH_REDIS_REST_URL as URL_BASE,
  UPSTASH_REDIS_REST_TOKEN as TOKEN
} from '../config.js'

const STATE_KEY = rid => `cc:room:${rid}`
const CHAN_KEY  = rid => `cc:chan:${rid}`

export function isConfigured() {
  return Boolean(URL_BASE && TOKEN)
}

const authHeaders = () => ({ Authorization: `Bearer ${TOKEN}` })
const jsonHeaders = () => ({ ...authHeaders(), 'Content-Type': 'application/json' })

async function runCommand(command) {
  const res = await fetch(URL_BASE, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify(command)
  })
  if (!res.ok) throw new Error(`Upstash ${command[0]} failed: HTTP ${res.status}`)
  return res.json()
}

// One tournament's state.
export async function getRoomState(roomId) {
  if (!isConfigured() || !roomId) return null
  try {
    const res = await fetch(
      `${URL_BASE}/get/${encodeURIComponent(STATE_KEY(roomId))}`,
      { headers: authHeaders() }
    )
    if (!res.ok) return null
    const data = await res.json()
    if (!data?.result) return null
    return JSON.parse(data.result)
  } catch (e) {
    console.warn('[cloudsync] getRoomState failed', roomId, e)
    return null
  }
}

// Batched fetch for the home view — one round-trip for all known rooms.
export async function getRoomStates(roomIds) {
  const out = {}
  if (!isConfigured() || !roomIds?.length) return out
  try {
    const path = roomIds.map(r => encodeURIComponent(STATE_KEY(r))).join('/')
    const res = await fetch(`${URL_BASE}/mget/${path}`, { headers: authHeaders() })
    if (!res.ok) return out
    const data = await res.json()
    const results = Array.isArray(data?.result) ? data.result : []
    roomIds.forEach((rid, i) => {
      const raw = results[i]
      if (raw == null) return
      try { out[rid] = JSON.parse(raw) } catch {}
    })
  } catch (e) {
    console.warn('[cloudsync] getRoomStates failed', e)
  }
  return out
}

// Write full state + notify subscribers.
export async function setRoomState(roomId, stateObj) {
  if (!isConfigured() || !roomId) return false
  try {
    await runCommand(['SET', STATE_KEY(roomId), JSON.stringify(stateObj)])
    // Fire the notification but don't fail the write if publish hiccups.
    try { await runCommand(['PUBLISH', CHAN_KEY(roomId), String(stateObj?.v ?? 0)]) } catch {}
    return true
  } catch (e) {
    console.warn('[cloudsync] setRoomState failed', roomId, e)
    return false
  }
}

// Open an SSE stream that fires `onUpdate()` for every published event
// on the room's channel. Returns a disposer that closes the stream.
// Auto-reconnects via native EventSource behavior on transient errors.
export function subscribeToRoom(roomId, onUpdate) {
  if (!isConfigured() || !roomId) return () => {}
  // EventSource can't set custom headers, so we pass the token as a
  // query parameter. Upstash supports this form of auth on /subscribe.
  const url = `${URL_BASE}/subscribe/${encodeURIComponent(CHAN_KEY(roomId))}?_token=${encodeURIComponent(TOKEN)}`
  let es
  try { es = new EventSource(url) }
  catch (e) {
    console.warn('[cloudsync] subscribe failed to open', e)
    return () => {}
  }
  const handler = () => { try { onUpdate() } catch (e) { console.warn(e) } }
  es.addEventListener('message', handler)
  es.onerror = () => { /* EventSource auto-retries; nothing to do */ }
  return () => { try { es.close() } catch {} }
}
