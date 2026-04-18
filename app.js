// ============================================================================
// Carnage Courts — Badminton Tournament Engine
// State is persisted in Upstash Redis; every device reads/writes the same
// canonical copy and subscribes to change events via Server-Sent Events.
// localStorage is a cache for fast loads and offline viewing.
// ============================================================================

import {
  buildSchedule,
  generateRoomName,
  generateTeamName,
  shuffled,
  toDateInputValue
} from './lib/scheduler.mjs'
import { validateScore } from './lib/scoring.mjs'
import {
  isConfigured as cloudConfigured,
  getRoomState,
  getRoomStates,
  setRoomState,
  subscribeToRoom
} from './lib/cloudsync.mjs'

// ---------------------------------------------------------------------------
// Constants & config
// ---------------------------------------------------------------------------

const APP_ID = 'carnage-courts-v1'
const STATE_VERSION = 1
const DEFAULT_COURTS = 4
const MAX_COURTS = 8
const MIN_COURTS = 1

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

const $ = (sel, root = document) => root.querySelector(sel)
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel))

const uid = () => Math.random().toString(36).slice(2, 10)

async function sha256(s) {
  const data = new TextEncoder().encode(s)
  const buf = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const initialState = () => ({
  v: 0,
  schemaVersion: STATE_VERSION,
  createdAt: null,
  updatedAt: null,
  tournamentDate: null,      // ISO YYYY-MM-DD; the day the event happens
  roomId: null,
  pinHash: null,
  pinSalt: null,
  courts: DEFAULT_COURTS,
  players: [],
  teams: null,
  matches: [],
  status: 'lobby'
})

let state = initialState()
let unsubscribeFromRoom = null   // disposer for the current SSE subscription
let myName = localStorage.getItem('cc:myName') || ''

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const LS_STATE = (roomId) => `cc:state:${roomId}`
const LS_PIN   = (roomId) => `cc:pin:${roomId}`

function saveLocal() {
  if (!state.roomId) return
  try {
    localStorage.setItem(LS_STATE(state.roomId), JSON.stringify(state))
  } catch (e) {
    console.warn('localStorage save failed', e)
  }
}

function loadLocal(roomId) {
  try {
    const raw = localStorage.getItem(LS_STATE(roomId))
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Cloud sync (Upstash Redis REST + SSE)
// ---------------------------------------------------------------------------

async function joinCloudRoom(roomId) {
  leaveCloudRoom()  // tear down any prior subscription
  setConnStatus('connecting', 'Connecting…')

  // Fetch the canonical copy. If it's ahead of our local, adopt it.
  const remote = await getRoomState(roomId)
  if (remote) {
    if (remote.deleted) {
      localStorage.removeItem(LS_STATE(roomId))
      localStorage.removeItem(LS_PIN(roomId))
      clearRoomFromURL()
      state = initialState()
      toast('Tournament deleted')
      showHome()
      setConnStatus('offline', 'Offline')
      return
    }
    if ((remote.v || 0) > (state.v || 0)) {
      state = remote
      saveLocal()
      render()
    } else if ((state.v || 0) > (remote.v || 0)) {
      // Our local is ahead (e.g., offline edits). Push ours.
      await setRoomState(roomId, state)
    }
  } else if (state.v > 0 && state.roomId === roomId) {
    // No remote copy yet, but we have local state — seed the cloud.
    await setRoomState(roomId, state)
  }

  // Subscribe: any published event triggers a fresh GET.
  unsubscribeFromRoom = subscribeToRoom(roomId, async () => {
    const fresh = await getRoomState(roomId)
    if (!fresh) return
    if (fresh.deleted && state.roomId === roomId) {
      localStorage.removeItem(LS_STATE(roomId))
      localStorage.removeItem(LS_PIN(roomId))
      leaveCloudRoom()
      state = initialState()
      clearRoomFromURL()
      toast('Tournament deleted')
      showHome()
      return
    }
    if ((fresh.v || 0) > (state.v || 0)) {
      state = fresh
      saveLocal()
      render()
    }
  })

  setConnStatus(cloudConfigured() ? 'online' : 'offline',
                cloudConfigured() ? 'Online' : 'Local only')
}

function leaveCloudRoom() {
  if (unsubscribeFromRoom) {
    try { unsubscribeFromRoom() } catch {}
    unsubscribeFromRoom = null
  }
}

// Push the current state to the cloud. Called after every mutate().
// Fire-and-forget — local writes succeed regardless of network.
function publishState() {
  if (!state.roomId) return
  setRoomState(state.roomId, state).catch(e => console.warn('publish failed', e))
}

// Marks a room as deleted in the cloud, which every subscriber picks up
// and applies locally. Also writes the tombstone to localStorage on this
// device so the UI updates immediately without waiting for the round-trip.
async function broadcastDelete(roomId) {
  const local = loadLocal(roomId) || { roomId }
  const tombstone = {
    ...local,
    roomId,
    deleted: true,
    v: (local.v || 0) + 1,
    updatedAt: Date.now()
  }
  localStorage.setItem(LS_STATE(roomId), JSON.stringify(tombstone))
  localStorage.removeItem(LS_PIN(roomId))
  await setRoomState(roomId, tombstone)
}

// On home view, pull the latest state of every locally-known room so
// the card list reflects any updates made on other devices while this
// one was offline. Idempotent; safe to call on every home render.
async function syncAllRoomsFromCloud() {
  if (!cloudConfigured()) return
  const local = enumerateLocalRooms()
  if (!local.length) return
  const states = await getRoomStates(local.map(s => s.roomId))
  let changed = false
  for (const rid in states) {
    const remote = states[rid]
    if (!remote) continue
    const cur = loadLocal(rid)
    if (!cur || (remote.v || 0) > (cur.v || 0)) {
      localStorage.setItem(LS_STATE(rid), JSON.stringify(remote))
      changed = true
    }
  }
  if (changed && !state.roomId) renderHome()
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

function mutate(fn) {
  const next = structuredClone(state)
  fn(next)
  next.v = (state.v || 0) + 1
  next.updatedAt = Date.now()
  state = next
  saveLocal()
  publishState()
  render()
}

async function createRoom({ roomName, pin, tournamentDate }) {
  const salt = uid()
  const pinHash = await sha256(pin + ':' + roomName + ':' + salt)
  state = initialState()
  state.roomId = roomName
  state.pinHash = pinHash
  state.pinSalt = salt
  state.createdAt = Date.now()
  state.updatedAt = state.createdAt
  state.tournamentDate = tournamentDate || toDateInputValue(new Date())
  state.v = 1
  localStorage.setItem(LS_PIN(roomName), pin)  // creator device caches PIN
  saveLocal()
  setRoomInURL(roomName)
  // Seed the cloud, then subscribe for updates from other devices.
  await setRoomState(roomName, state)
  joinCloudRoom(roomName)
  // Auto-register the creator if we remember their name — they're clearly
  // playing the tournament they just created.
  if (myName && !state.players.some(p => p.name.toLowerCase() === myName.toLowerCase())) {
    addPlayer(myName)
  }
  render()
}

function addPlayer(name, isSelf = true) {
  name = name.trim()
  if (!name) return
  // Trust model: if someone types a name already in the roster, and this
  // is a self-registration, treat it as claiming their existing slot from
  // another device. For "add someone else" the claim path just toasts.
  const existing = state.players.find(p => p.name.toLowerCase() === name.toLowerCase())
  if (existing) {
    if (isSelf) {
      myName = existing.name
      localStorage.setItem('cc:myName', myName)
      toast(`Welcome back, ${myName}`)
    } else {
      toast(`${existing.name} is already in`)
    }
    render()
    return
  }
  // Bind this device's identity BEFORE mutate() — mutate() calls render()
  // synchronously, so myName must already be set for the lobby banner to
  // appear on the same render cycle.
  if (isSelf) {
    myName = name
    localStorage.setItem('cc:myName', name)
  }
  mutate(s => {
    s.players.push({ id: uid(), name, joinedAt: Date.now() })
  })
}

function removePlayer(id) {
  mutate(s => {
    s.players = s.players.filter(p => p.id !== id)
  })
}

function randomizeTeams() {
  if (state.players.length < 4) {
    toast('Need at least 4 players')
    return
  }
  mutate(s => {
    const seed = Date.now() >>> 0
    const shuffledPlayers = shuffled(s.players, seed)
    const teams = []
    for (let i = 0; i < shuffledPlayers.length; i += 2) {
      const p1 = shuffledPlayers[i]
      const p2 = shuffledPlayers[i + 1]
      if (!p2) {
        // Odd player — single-player team (effectively sits out a round with BYE)
        teams.push({ id: uid(), playerIds: [p1.id], name: `${p1.name} (solo)` })
      } else {
        const ids = [p1.id, p2.id]
        teams.push({ id: uid(), playerIds: ids, name: generateTeamName(ids) })
      }
    }
    s.teams = teams
    s.matches = buildSchedule(teams, s.courts)
    s.status = 'in_progress'
  })
  toast('Teams randomized. Godspeed.')
  showTab('matches')
}

function setScore(matchId, a, b) {
  const A = parseInt(a, 10)
  const B = parseInt(b, 10)
  const result = validateScore(A, B)
  if (!result.ok) { toast(result.reason); return }
  mutate(s => {
    const m = s.matches.find(x => x.id === matchId)
    if (!m) return
    m.scoreA = A
    m.scoreB = B
    m.done = true
    if (s.matches.every(x => x.done)) s.status = 'finished'
  })
}

function clearScore(matchId) {
  mutate(s => {
    const m = s.matches.find(x => x.id === matchId)
    if (!m) return
    m.scoreA = null
    m.scoreB = null
    m.done = false
    s.status = 'in_progress'
  })
}

function resetTournament() {
  mutate(s => {
    s.teams = null
    s.matches = []
    s.status = 'lobby'
  })
  toast('Tournament reset. Fresh carnage incoming.')
  showTab('lobby')
}

function setCourts(n) {
  n = Math.max(MIN_COURTS, Math.min(MAX_COURTS, n | 0))
  mutate(s => {
    s.courts = n
    if (s.teams && s.teams.length >= 2) {
      // Re-generate schedule with new court count, preserving any completed scores
      const oldResults = new Map()
      s.matches.forEach(m => {
        if (m.done) oldResults.set(`${m.teamAId}|${m.teamBId}`, { a: m.scoreA, b: m.scoreB })
      })
      s.matches = buildSchedule(s.teams, n)
      s.matches.forEach(m => {
        const key1 = `${m.teamAId}|${m.teamBId}`
        const key2 = `${m.teamBId}|${m.teamAId}`
        const prev = oldResults.get(key1) || oldResults.get(key2)
        if (prev) {
          // Match the original orientation
          if (oldResults.get(key1)) { m.scoreA = prev.a; m.scoreB = prev.b }
          else { m.scoreA = prev.b; m.scoreB = prev.a }
          m.done = true
        }
      })
    }
  })
}

// ---------------------------------------------------------------------------
// PIN gate
// ---------------------------------------------------------------------------

async function verifyPin(pin) {
  const hash = await sha256(pin + ':' + state.roomId + ':' + state.pinSalt)
  return hash === state.pinHash
}

function getCachedPin() {
  if (!state.roomId) return null
  return localStorage.getItem(LS_PIN(state.roomId))
}

async function requirePin(reason) {
  const cached = getCachedPin()
  if (cached && await verifyPin(cached)) return true

  return new Promise(resolve => {
    const modal = $('[data-role="pin-modal"]')
    const input = $('[data-role="pin-input"]')
    const err   = $('[data-role="pin-error"]')
    $('[data-role="pin-reason"]').textContent = reason || 'Enter the 2-digit PIN to continue.'
    err.classList.add('hidden')
    input.value = ''
    modal.classList.remove('hidden')
    setTimeout(() => input.focus(), 50)

    const close = (ok) => {
      modal.classList.add('hidden')
      $('[data-role="pin-submit"]').onclick = null
      $('[data-role="pin-cancel"]').onclick = null
      input.onkeydown = null
      resolve(ok)
    }

    const submit = async () => {
      const pin = input.value.trim()
      if (!/^\d{2}$/.test(pin)) {
        err.textContent = 'PIN must be 2 digits.'
        err.classList.remove('hidden')
        return
      }
      if (await verifyPin(pin)) {
        localStorage.setItem(LS_PIN(state.roomId), pin)
        close(true)
      } else {
        err.textContent = 'Wrong PIN.'
        err.classList.remove('hidden')
        input.value = ''
      }
    }

    $('[data-role="pin-submit"]').onclick = submit
    $('[data-role="pin-cancel"]').onclick = () => close(false)
    input.onkeydown = (e) => { if (e.key === 'Enter') submit() }
  })
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

let currentTab = 'lobby'

function showView(view) {
  $$('[data-view]').forEach(el => el.classList.add('hidden'))
  const target = $(`[data-view="${view}"]`)
  if (target) target.classList.remove('hidden')
}

function showTab(tab) {
  currentTab = tab
  showView(tab)
  $$('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab))
}

function showHome() {
  $('[data-role="tabbar"]').classList.add('hidden')
  $('[data-role="share-btn"]').classList.add('hidden')
  $('[data-role="room-name"]').textContent = 'Carnage Courts'
  setConnStatus(cloudConfigured() ? 'online' : 'offline',
                cloudConfigured() ? 'Home' : 'Offline (local)')
  renderHome()
  showView('home')
  // Fetch the latest snapshot of every locally-known room so cards
  // reflect updates made on other devices while this one was closed.
  syncAllRoomsFromCloud()
}

function showWelcome() {
  $('[data-role="tabbar"]').classList.add('hidden')
  $('[data-role="share-btn"]').classList.add('hidden')
  $('[data-role="room-name"]').textContent = 'Carnage Courts'
  setConnStatus('offline', 'Welcome')
  showView('welcome')
  const input = $('[data-role="welcome-name"]')
  if (input) {
    input.value = myName || ''
    setTimeout(() => input.focus(), 100)
  }
}

function showSetup({ fromHome = false } = {}) {
  $('[data-role="tabbar"]').classList.add('hidden')
  $('[data-role="share-btn"]').classList.add('hidden')
  $('[data-role="room-name"]').textContent = 'New Tournament'
  const backBtn = $('[data-role="setup-back"]')
  backBtn.classList.toggle('hidden', !fromHome)
  showView('setup')
}

function setConnStatus(kind, label) {
  const dot = $('[data-role="conn-dot"]')
  const lab = $('[data-role="conn-label"]')
  dot.classList.remove('bg-sub', 'bg-volt', 'bg-amber', 'bg-danger', 'pulse-dot')
  if (kind === 'online')     { dot.classList.add('bg-volt', 'pulse-dot') }
  else if (kind === 'connecting') { dot.classList.add('bg-amber') }
  else                        { dot.classList.add('bg-sub') }
  lab.textContent = label
}

function render() {
  if (!state.roomId) {
    // Home/setup is handled separately via showHome()/showSetup().
    return
  }

  $('[data-role="tabbar"]').classList.remove('hidden')
  $('[data-role="share-btn"]').classList.remove('hidden')
  $('[data-role="room-name"]').textContent = state.roomId

  renderLobby()
  renderMatches()
  renderLeaderboard()

  // If we landed on setup/home but have a room now, switch to lobby
  const inRoomView = ['lobby', 'matches', 'leaderboard'].some(
    v => !$(`[data-view="${v}"]`).classList.contains('hidden')
  )
  if (!inRoomView) showTab(currentTab || 'lobby')
}

// ---------------------------------------------------------------------------
// Home view: enumerates tournaments stored on this device
// ---------------------------------------------------------------------------

const TOMBSTONE_TTL_MS = 7 * 24 * 3600 * 1000  // garbage-collect after 7 days

function enumerateLocalRooms() {
  const rooms = []
  const now = Date.now()
  const keys = []
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    if (k?.startsWith('cc:state:')) keys.push(k)
  }
  for (const key of keys) {
    try {
      const s = JSON.parse(localStorage.getItem(key))
      if (!s?.roomId) continue
      // Expire stale tombstones — once propagated, the network doesn't
      // need them around forever, and holding them opens unnecessary
      // WebRTC connections on every home visit.
      if (s.deleted && (now - (s.updatedAt || 0)) > TOMBSTONE_TTL_MS) {
        localStorage.removeItem(key)
        continue
      }
      rooms.push(s)
    } catch {}
  }
  return rooms
}

function parseISODateLocal(iso) {
  if (!iso) return null
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d)
}

function tournamentDateOf(s) {
  // Prefer explicit tournamentDate; fall back to createdAt for legacy rooms
  if (s.tournamentDate) return parseISODateLocal(s.tournamentDate)
  if (s.createdAt) return new Date(s.createdAt)
  return null
}

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

function daysFromToday(date) {
  if (!date) return null
  const today = startOfDay(new Date())
  const d = startOfDay(date)
  return Math.round((d - today) / 86400000)
}

function formatCardDate(date) {
  if (!date) return ''
  return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}

function computeLeader(s) {
  if (!s.teams || !s.matches?.length) return null
  const done = s.matches.filter(m => m.done)
  if (!done.length) return null
  const stats = new Map(s.teams.map(t => [t.id, { team: t, wins: 0, diff: 0 }]))
  for (const m of done) {
    const a = stats.get(m.teamAId), b = stats.get(m.teamBId)
    if (!a || !b) continue
    a.diff += (m.scoreA - m.scoreB); b.diff += (m.scoreB - m.scoreA)
    if (m.scoreA > m.scoreB) a.wins++; else b.wins++
  }
  const sorted = [...stats.values()].sort((x, y) => y.wins - x.wins || y.diff - x.diff)
  return sorted[0]?.team?.name
}

function renderTournamentCard(s, { isPast }) {
  const li = document.createElement('li')
  li.className = `bg-panel border border-line rounded-2xl p-4 flex items-center gap-3 ${isPast ? 'opacity-80' : ''}`
  li.dataset.resumeRoom = s.roomId
  li.style.cursor = 'pointer'

  const players = s.players?.length || 0
  const totalMatches = s.matches?.length || 0
  const doneMatches = s.matches?.filter(m => m.done).length || 0
  const statusLabel = s.status === 'finished' ? 'Finished'
    : (s.status === 'in_progress' ? 'In progress' : 'Lobby')
  const statusColor = s.status === 'finished' ? 'text-amber'
    : (s.status === 'in_progress' ? 'text-volt' : 'text-sub')

  const signedUpNames = (s.players || []).map(p => p.name)
  const signedUpPreview = signedUpNames.slice(0, 4).join(', ') +
    (signedUpNames.length > 4 ? ` +${signedUpNames.length - 4}` : '')

  // "Played" = players who appear in at least one completed match
  const playedIds = new Set()
  for (const m of (s.matches || [])) {
    if (!m.done) continue
    const a = s.teams?.find(t => t.id === m.teamAId)
    const b = s.teams?.find(t => t.id === m.teamBId)
    for (const pid of [...(a?.playerIds || []), ...(b?.playerIds || [])]) playedIds.add(pid)
  }
  const playedCount = playedIds.size

  const leader = computeLeader(s)
  const tDate = tournamentDateOf(s)
  const dDelta = daysFromToday(tDate)
  let dateStr = formatCardDate(tDate)
  if (dDelta === 0) dateStr = 'Today'
  else if (dDelta === 1) dateStr = 'Tomorrow'
  else if (dDelta === -1) dateStr = 'Yesterday'

  const meSignedUp = myName && (s.players || []).some(p => p.name.toLowerCase() === myName.toLowerCase())
  const primaryActionLabel = isPast
    ? 'View'
    : (meSignedUp
        ? (s.status === 'in_progress' ? 'Play' : 'Open')
        : (s.status === 'lobby' ? 'Sign up' : 'Watch'))

  li.innerHTML = `
    <div class="flex-1 min-w-0">
      <div class="flex items-baseline justify-between gap-2">
        <div class="font-display font-bold text-ink truncate">${escapeHtml(s.roomId)}</div>
        <span class="text-[10px] ${statusColor} uppercase tracking-widest shrink-0">${statusLabel}</span>
      </div>
      <div class="text-xs text-sub mt-0.5 truncate">
        ${dateStr ? escapeHtml(dateStr) + ' · ' : ''}${players} signed up${playedCount ? ` · ${playedCount} played` : ''}${totalMatches ? ` · ${doneMatches}/${totalMatches} matches` : ''}
      </div>
      ${signedUpPreview ? `<div class="text-xs text-sub mt-1 truncate">👥 ${escapeHtml(signedUpPreview)}</div>` : ''}
      ${leader ? `<div class="text-xs text-volt mt-0.5 truncate">🏆 ${escapeHtml(leader)}</div>` : ''}
    </div>
    <div class="flex flex-col gap-1 shrink-0">
      <span class="bg-volt text-bg text-xs font-bold px-3 py-2 rounded-lg text-center pointer-events-none">${primaryActionLabel}</span>
      <button type="button" data-delete-room="${escapeHtml(s.roomId)}"
              class="bg-panel2 border border-line text-sub text-xs px-3 py-2 rounded-lg active:scale-95 transition"
              aria-label="Remove from this device">🗑</button>
    </div>
  `
  return li
}

function renderHome() {
  // Update greeting
  const greeting = $('[data-role="home-greeting"]')
  if (myName) {
    greeting.classList.remove('hidden')
    $('[data-role="home-greeting-name"]').textContent = myName
  } else {
    greeting.classList.add('hidden')
  }

  // Hide tombstoned rooms from the UI; they still live in localStorage
  // so the home listener can keep broadcasting them to new peers.
  const all = enumerateLocalRooms().filter(s => !s.deleted)

  // Split by tournament date — today or future = "Happening Now / Upcoming",
  // strictly before today = "Previous".
  const today = []
  const past  = []
  for (const s of all) {
    const delta = daysFromToday(tournamentDateOf(s))
    if (delta === null || delta >= 0) today.push(s)
    else past.push(s)
  }
  today.sort((a, b) => (daysFromToday(tournamentDateOf(a)) ?? 0) - (daysFromToday(tournamentDateOf(b)) ?? 0))
  past.sort((a, b) => (tournamentDateOf(b)?.getTime() || 0) - (tournamentDateOf(a)?.getTime() || 0))

  const todaySection = $('[data-role="home-today"]')
  const todayList = $('[data-role="home-today-list"]')
  const pastSection = $('[data-role="home-past"]')
  const pastList = $('[data-role="home-past-list"]')
  const emptySection = $('[data-role="home-empty"]')

  todayList.innerHTML = ''
  pastList.innerHTML = ''

  if (today.length) {
    todaySection.classList.remove('hidden')
    today.forEach(s => todayList.appendChild(renderTournamentCard(s, { isPast: false })))
  } else {
    todaySection.classList.add('hidden')
  }

  if (past.length) {
    pastSection.classList.remove('hidden')
    past.forEach(s => pastList.appendChild(renderTournamentCard(s, { isPast: true })))
  } else {
    pastSection.classList.add('hidden')
  }

  if (!today.length && !past.length) {
    emptySection.classList.remove('hidden')
  } else {
    emptySection.classList.add('hidden')
  }
}

function renderLobby() {
  const list = $('[data-role="player-list"]')
  const empty = $('[data-role="player-empty"]')
  list.innerHTML = ''
  if (state.players.length === 0) {
    empty.classList.remove('hidden')
  } else {
    empty.classList.add('hidden')
    state.players.forEach(p => {
      const li = document.createElement('li')
      li.className = 'flex items-center justify-between py-3'
      const isMe = p.name === myName
      li.innerHTML = `
        <div class="flex items-center gap-3 min-w-0">
          <div class="w-8 h-8 rounded-full bg-panel2 border border-line flex items-center justify-center text-xs font-bold">
            ${escapeHtml(p.name.slice(0, 1).toUpperCase())}
          </div>
          <span class="truncate ${isMe ? 'text-volt font-semibold' : ''}">${escapeHtml(p.name)}${isMe ? ' · you' : ''}</span>
        </div>
        <button data-remove="${p.id}" class="text-sub hover:text-danger text-xl px-2" aria-label="Remove">✕</button>
      `
      list.appendChild(li)
    })
    list.onclick = async (e) => {
      const btn = e.target.closest('[data-remove]')
      if (!btn) return
      if (state.teams) {
        if (!await requirePin('Removing a player after teams are set needs the PIN.')) return
      }
      removePlayer(btn.dataset.remove)
    }
  }
  $('[data-role="player-count"]').textContent = state.players.length

  // If the user is already registered on this device, collapse the
  // add-player form into a "Signed up as X" banner. Otherwise, show the
  // form with the remembered name pre-filled so they just tap Add.
  const nameInput = $('[data-role="add-player-name"]')
  const form = $('[data-role="add-player-form"]')
  const banner = $('[data-role="me-signed-up"]')
  const alreadyInRoom = myName && state.players.some(p => p.name.toLowerCase() === myName.toLowerCase())
  if (alreadyInRoom) {
    form.classList.add('hidden')
    banner.classList.remove('hidden')
    banner.classList.add('flex')
    $('[data-role="me-name"]').textContent = myName
    nameInput.value = ''
  } else {
    form.classList.remove('hidden')
    banner.classList.add('hidden')
    banner.classList.remove('flex')
    if (nameInput && !nameInput.value && myName) nameInput.value = myName
  }

  // Randomize button gating
  const rand = $('[data-role="randomize-teams"]')
  const canRandomize = state.players.length >= 4
  rand.disabled = !canRandomize
  rand.textContent = state.teams ? '🎲 Re-Randomize Teams' : '🎲 Randomize Teams'

  // Teams display
  const teamsList = $('[data-role="teams-list"]')
  const teamsEmpty = $('[data-role="teams-empty"]')
  const teamsStatus = $('[data-role="teams-status"]')
  teamsList.innerHTML = ''
  if (!state.teams || state.teams.length === 0) {
    teamsEmpty.classList.remove('hidden')
    teamsStatus.textContent = 'Unformed'
  } else {
    teamsEmpty.classList.add('hidden')
    teamsStatus.textContent = `${state.teams.length} teams`
    state.teams.forEach(t => {
      const div = document.createElement('div')
      div.className = 'bg-panel2 border border-line rounded-xl p-3'
      const playerNames = t.playerIds.map(id => state.players.find(p => p.id === id)?.name || '?').join(' + ')
      div.innerHTML = `
        <div class="font-display font-bold text-ink">${escapeHtml(t.name)}</div>
        <div class="text-xs text-sub mt-0.5 truncate">${escapeHtml(playerNames)}</div>
      `
      teamsList.appendChild(div)
    })
  }

  $('[data-role="court-count"]').textContent = state.courts
}

function renderMatches() {
  const list = $('[data-role="matches-list"]')
  const empty = $('[data-role="matches-empty"]')
  list.innerHTML = ''
  if (!state.matches || state.matches.length === 0) {
    empty.classList.remove('hidden')
    return
  }
  empty.classList.add('hidden')

  // Group by round
  const byRound = new Map()
  state.matches.forEach(m => {
    if (!byRound.has(m.round)) byRound.set(m.round, [])
    byRound.get(m.round).push(m)
  })

  const teamById = new Map(state.teams.map(t => [t.id, t]))

  Array.from(byRound.entries()).sort((a, b) => a[0] - b[0]).forEach(([round, matches]) => {
    const section = document.createElement('div')
    section.className = 'space-y-2'
    const doneCount = matches.filter(m => m.done).length
    section.innerHTML = `
      <div class="flex items-baseline justify-between px-1">
        <h3 class="font-display text-lg font-bold">Round ${round}</h3>
        <span class="text-xs text-sub">${doneCount}/${matches.length} done</span>
      </div>
    `
    matches
      .slice()
      .sort((a, b) => a.wave - b.wave || a.court - b.court)
      .forEach(m => section.appendChild(renderMatchCard(m, teamById)))
    list.appendChild(section)
  })
}

function renderMatchCard(m, teamById) {
  const card = document.createElement('div')
  const A = teamById.get(m.teamAId)
  const B = teamById.get(m.teamBId)
  const aWon = m.done && m.scoreA > m.scoreB
  const bWon = m.done && m.scoreB > m.scoreA

  card.className = `bg-panel border border-line rounded-2xl p-4 ${m.done ? 'opacity-90' : ''}`
  card.innerHTML = `
    <div class="flex items-center justify-between mb-3">
      <div class="text-xs uppercase tracking-widest text-sub font-semibold">
        Court ${m.court}${m.wave > 1 ? ` · Wave ${m.wave}` : ''}
      </div>
      <div class="text-xs ${m.done ? 'text-volt' : 'text-sub'} font-semibold uppercase tracking-widest">
        ${m.done ? 'Final' : 'Pending'}
      </div>
    </div>

    <div class="grid grid-cols-[1fr_auto_1fr] gap-3 items-center">
      <div class="team-side p-3 rounded-xl border border-line ${aWon ? 'winner' : (m.done ? 'loser' : '')}">
        <div class="font-display font-bold truncate">${escapeHtml(A?.name || '?')}</div>
        <div class="text-xs text-sub mt-0.5 truncate">${escapeHtml(playerNames(A))}</div>
        <input type="number" class="score-input mt-2"
               inputmode="numeric" min="0" max="30"
               data-score="${m.id}" data-side="a"
               value="${m.scoreA ?? ''}"
               placeholder="–" />
      </div>

      <div class="text-center text-sub font-display font-bold">vs</div>

      <div class="team-side p-3 rounded-xl border border-line ${bWon ? 'winner' : (m.done ? 'loser' : '')}">
        <div class="font-display font-bold truncate text-right">${escapeHtml(B?.name || '?')}</div>
        <div class="text-xs text-sub mt-0.5 truncate text-right">${escapeHtml(playerNames(B))}</div>
        <input type="number" class="score-input mt-2"
               inputmode="numeric" min="0" max="30"
               data-score="${m.id}" data-side="b"
               value="${m.scoreB ?? ''}"
               placeholder="–" />
      </div>
    </div>

    <div class="flex gap-2 mt-3">
      <button data-role="log-score" data-match="${m.id}"
              class="flex-1 bg-danger text-ink font-bold py-3 rounded-xl active:scale-95 transition">
        ${m.done ? '↻ Update Score' : '💀 Log the Carnage'}
      </button>
      ${m.done ? `<button data-role="clear-score" data-match="${m.id}" class="bg-panel2 border border-line px-4 rounded-xl text-sub">Clear</button>` : ''}
    </div>
  `
  return card
}

function playerNames(team) {
  if (!team) return ''
  return team.playerIds.map(id => state.players.find(p => p.id === id)?.name || '?').join(' + ')
}

function renderLeaderboard() {
  const list = $('[data-role="leaderboard-list"]')
  const empty = $('[data-role="leaderboard-empty"]')
  list.innerHTML = ''
  if (!state.teams || state.matches.every(m => !m.done)) {
    empty.classList.remove('hidden')
    return
  }
  empty.classList.add('hidden')

  const standings = state.teams.map(t => ({
    team: t,
    played: 0, wins: 0, losses: 0, pf: 0, pa: 0
  }))
  const byId = new Map(standings.map(s => [s.team.id, s]))

  state.matches.forEach(m => {
    if (!m.done) return
    const a = byId.get(m.teamAId), b = byId.get(m.teamBId)
    if (!a || !b) return
    a.played++; b.played++
    a.pf += m.scoreA; a.pa += m.scoreB
    b.pf += m.scoreB; b.pa += m.scoreA
    if (m.scoreA > m.scoreB) { a.wins++; b.losses++ }
    else                     { b.wins++; a.losses++ }
  })

  standings.sort((x, y) =>
    y.wins - x.wins ||
    (y.pf - y.pa) - (x.pf - x.pa) ||
    y.pf - x.pf
  )

  standings.forEach((s, i) => {
    const rankClass = i === 0 ? 'rank-1' : i === 1 ? 'rank-2' : i === 2 ? 'rank-3' : ''
    const li = document.createElement('li')
    li.className = `bg-panel border border-line rounded-2xl p-4 flex items-center gap-3 ${rankClass}`
    const diff = s.pf - s.pa
    const diffStr = (diff >= 0 ? '+' : '') + diff
    li.innerHTML = `
      <div class="w-10 h-10 rounded-full bg-panel2 border border-line flex items-center justify-center font-display font-bold text-lg ${i === 0 ? 'text-amber' : ''}">
        ${i + 1}
      </div>
      <div class="flex-1 min-w-0">
        <div class="font-display font-bold truncate">${escapeHtml(s.team.name)}</div>
        <div class="text-xs text-sub truncate">${escapeHtml(playerNames(s.team))}</div>
      </div>
      <div class="text-right">
        <div class="font-mono text-lg font-bold">${s.wins}<span class="text-sub text-sm font-normal">–${s.losses}</span></div>
        <div class="text-xs font-mono ${diff > 0 ? 'text-volt' : diff < 0 ? 'text-danger' : 'text-sub'}">${diffStr}</div>
      </div>
    `
    list.appendChild(li)
  })
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]))
}

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------

let toastTimer
function toast(msg, ms = 2200) {
  const el = $('[data-role="toast"]')
  el.firstElementChild.textContent = msg
  el.classList.remove('hidden')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el.classList.add('hidden'), ms)
}

// ---------------------------------------------------------------------------
// URL / room bootstrapping
// ---------------------------------------------------------------------------

function getRoomFromURL() {
  const params = new URLSearchParams(location.search)
  // Support both new short param `?r=` and legacy `?room=`
  return params.get('r') || params.get('room')
}

function setRoomInURL(roomId) {
  const url = new URL(location.href)
  url.searchParams.delete('room')
  url.searchParams.set('r', roomId)
  history.replaceState(null, '', url)
}

function clearRoomFromURL() {
  const url = new URL(location.href)
  url.searchParams.delete('r')
  url.searchParams.delete('room')
  history.replaceState(null, '', url)
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

// State for the setup screen — date + re-rollable suffix
let setupSuffix = randomSuffix()

function randomSuffix() {
  return Math.random().toString(36).replace(/[^a-z0-9]/g, '').slice(0, 2).padEnd(2, 'x')
}

function updateRoomPreview() {
  const dateInput = $('[data-role="new-room-date"]')
  const preview = $('[data-role="new-room-preview"]')
  if (!dateInput || !preview) return
  const dateStr = dateInput.value || toDateInputValue(new Date())
  // Parse as local midnight to avoid off-by-one day from UTC
  const [y, m, d] = dateStr.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  preview.textContent = generateRoomName(date, setupSuffix)
}

function wireSetup() {
  const dateInput = $('[data-role="new-room-date"]')
  const pinInput = $('[data-role="new-room-pin"]')
  dateInput.value = toDateInputValue(new Date())
  updateRoomPreview()

  dateInput.oninput = updateRoomPreview

  $('[data-role="roll-room-name"]').onclick = () => {
    setupSuffix = randomSuffix()
    updateRoomPreview()
  }

  $('[data-role="create-room"]').onclick = async () => {
    const roomName = $('[data-role="new-room-preview"]').textContent.trim()
    const tournamentDate = dateInput.value
    const pin = pinInput.value.trim()
    if (!roomName || roomName.length < 3) { toast('Pick a date first'); return }
    if (!/^\d{2}$/.test(pin)) { toast('PIN must be exactly 2 digits'); return }
    await createRoom({ roomName, pin, tournamentDate })
    showTab('lobby')
  }

  $('[data-role="setup-back"]').onclick = () => {
    showHome()
  }
}

function wireWelcome() {
  $('[data-role="welcome-form"]').onsubmit = (e) => {
    e.preventDefault()
    const v = $('[data-role="welcome-name"]').value.trim()
    if (!v || v.length > 24) { toast('Pick a name (1–24 chars)'); return }
    myName = v
    localStorage.setItem('cc:myName', v)

    // If the user arrived via a share URL (state.roomId already set),
    // auto-register them into that room and show the lobby.
    if (state.roomId) {
      if (!state.players.some(p => p.name.toLowerCase() === v.toLowerCase())) {
        addPlayer(v)
      }
      showTab('lobby')
    } else {
      showHome()
    }
  }
}

function wireHome() {
  $('[data-role="home-new"]').onclick = () => {
    setupSuffix = randomSuffix()
    updateRoomPreview()
    showSetup({ fromHome: true })
  }

  $('[data-role="home-change-name"]').onclick = () => {
    if (!confirm(`Change your identity on this device? You can always claim "${myName}" again by re-entering the same name.`)) return
    myName = ''
    localStorage.removeItem('cc:myName')
    leaveCloudRoom()
    showWelcome()
  }

  $('[data-role="join-existing"]').onclick = () => {
    const entered = prompt('Paste the tournament URL or room ID:')
    if (!entered) return
    // Accept either a room ID (e.g., sat18apr-qz) or a full share URL;
    // parse out ?r= or ?room= if present, otherwise use verbatim.
    let roomId = entered.trim()
    try {
      const u = new URL(entered)
      roomId = u.searchParams.get('r') || u.searchParams.get('room') || roomId
    } catch {}
    roomId = roomId.trim()
    if (roomId.length >= 3) {
      setRoomInURL(roomId)
      location.reload()
    } else {
      toast('That doesn\'t look like a room ID.')
    }
  }

  // Delegated click for resume + delete on tournament cards
  const onCardClick = async (e) => {
    const del = e.target.closest('[data-delete-room]')
    if (del) {
      e.stopPropagation()
      const rid = del.dataset.deleteRoom
      if (!confirm(`Delete "${rid}"? This will try to remove it from everyone's device in the room.`)) return
      del.disabled = true
      try {
        await broadcastDelete(rid)
        // broadcastDelete persists the tombstone in LS; we don't remove
        // it here (it stays so the home listener keeps serving it to
        // peers who come online later). renderHome filters it out.
      } finally {
        renderHome()
      }
      return
    }
    const card = e.target.closest('[data-resume-room]')
    if (card) {
      const rid = card.dataset.resumeRoom
      setRoomInURL(rid)
      location.reload()
    }
  }
  $('[data-role="home-today-list"]').addEventListener('click', onCardClick)
  $('[data-role="home-past-list"]').addEventListener('click', onCardClick)
}

function wireBrand() {
  $('[data-role="brand"]').onclick = () => {
    // If in a room, go back to home. If already on home/setup, no-op.
    if (state.roomId) {
      leaveCloudRoom()
      state = initialState()
      clearRoomFromURL()
      showHome()
    }
  }
}

function wireLobby() {
  $('[data-role="add-player-form"]').onsubmit = (e) => {
    e.preventDefault()
    const input = $('[data-role="add-player-name"]')
    const v = input.value
    if (!v.trim()) return
    // If this device's user is already in the roster, this submission
    // must be "add someone else" — don't reassign myName.
    const isSelf = !(myName && state.players.some(p => p.name.toLowerCase() === myName.toLowerCase()))
    addPlayer(v, isSelf)
    input.value = ''
  }

  $('[data-role="add-someone-else"]').onclick = () => {
    const form = $('[data-role="add-player-form"]')
    const banner = $('[data-role="me-signed-up"]')
    form.classList.remove('hidden')
    banner.classList.add('hidden')
    banner.classList.remove('flex')
    const input = $('[data-role="add-player-name"]')
    input.value = ''
    input.focus()
  }

  $('[data-role="randomize-teams"]').onclick = async () => {
    if (!await requirePin('Randomizing teams requires the admin PIN.')) return
    if (state.teams && !confirm('Teams already exist. Re-randomize and reset all scores?')) return
    randomizeTeams()
  }

  $('[data-role="reset-tournament"]').onclick = async () => {
    if (!await requirePin('Resetting the tournament requires the admin PIN.')) return
    if (!confirm('Reset tournament? Players and teams will be wiped.')) return
    resetTournament()
  }

  $('[data-role="change-courts"]').onclick = async () => {
    if (state.teams) {
      if (!await requirePin('Changing court count rebuilds the schedule. Needs PIN.')) return
    }
    const v = prompt(`Number of courts (${MIN_COURTS}–${MAX_COURTS}):`, state.courts)
    const n = parseInt(v, 10)
    if (Number.isFinite(n) && n >= MIN_COURTS && n <= MAX_COURTS) setCourts(n)
  }
}

function wireMatches() {
  // Score logging is open — anyone playing can log their match. PIN only
  // gates structural changes (randomize, reset, court count).
  $('[data-role="matches-list"]').addEventListener('click', (e) => {
    const logBtn = e.target.closest('[data-role="log-score"]')
    if (logBtn) {
      const id = logBtn.dataset.match
      const a = $(`[data-score="${id}"][data-side="a"]`).value
      const b = $(`[data-score="${id}"][data-side="b"]`).value
      setScore(id, a, b)
      return
    }
    const clearBtn = e.target.closest('[data-role="clear-score"]')
    if (clearBtn) {
      clearScore(clearBtn.dataset.match)
    }
  })
}

function wireTabs() {
  $$('.tab-btn').forEach(b => {
    b.onclick = () => showTab(b.dataset.tab)
  })
}

function wireShare() {
  $('[data-role="share-btn"]').onclick = async () => {
    const url = location.href
    const text = `Join my badminton tournament: ${state.roomId}`
    if (navigator.share) {
      try { await navigator.share({ title: 'Carnage Courts', text, url }); return } catch {}
    }
    try {
      await navigator.clipboard.writeText(url)
      toast('Link copied')
    } catch {
      prompt('Copy this URL:', url)
    }
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  wireWelcome()
  wireSetup()
  wireHome()
  wireLobby()
  wireMatches()
  wireTabs()
  wireShare()
  wireBrand()

  const urlRoom = getRoomFromURL()

  // Preload local state for the URL'd room so a returning identified user
  // lands in the lobby without a blank flash, and a first-time visitor
  // with a share link still gets welcome → auto-join.
  if (urlRoom) {
    const local = loadLocal(urlRoom)
    if (local) state = local
    else { state = initialState(); state.roomId = urlRoom }
    setRoomInURL(urlRoom) // normalise legacy ?room= to ?r=
    // joinCloudRoom handles delete detection — it fetches the cloud
    // state, notices deleted:true, and bounces to home with a toast.
    joinCloudRoom(urlRoom)
  }

  // Every user must identify themselves once per device. The name seeds
  // the claim-slot logic that keeps multi-device usage coherent.
  if (!myName) {
    showWelcome()
    return
  }

  if (urlRoom) {
    showTab('lobby')
    render()
  } else {
    showHome()
  }
}

boot()
