// ============================================================================
// Carnage Courts — Badminton Tournament Engine
// Zero-auth, peer-to-peer. State lives in localStorage; syncs via WebRTC.
// ============================================================================

// Trystero "nostr" strategy: WebRTC signaling over public Nostr relays.
// Unlike the default "torrent" strategy (BitTorrent trackers — often blocked
// by managed-device firewalls and corporate DPI), Nostr uses plain wss://
// connections to general-purpose relay servers, so it passes through
// restrictive networks that block BitTorrent traffic.
import { joinRoom, selfId } from 'https://cdn.jsdelivr.net/npm/@trystero-p2p/nostr@0.23.0/+esm'
import { buildSchedule, generateRoomName, generateTeamName, shuffled } from './lib/scheduler.mjs'
import { validateScore } from './lib/scoring.mjs'

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
let roomHandle = null     // Trystero room
let sendStateAction = null
let getStateAction = null
let peerCount = 0
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
// P2P sync (Trystero / WebRTC)
// ---------------------------------------------------------------------------

function joinTrysteroRoom(roomId) {
  if (roomHandle) {
    roomHandle.leave()
    roomHandle = null
  }
  setConnStatus('connecting', 'Connecting…')

  try {
    roomHandle = joinRoom({ appId: APP_ID }, roomId)
  } catch (e) {
    console.error('trystero join failed', e)
    setConnStatus('offline', 'Offline (local only)')
    return
  }

  const [sendSt, getSt] = roomHandle.makeAction('state')
  sendStateAction = sendSt
  getStateAction = getSt

  getStateAction((remote, peerId) => {
    if (!remote || typeof remote.v !== 'number') return
    if (remote.v > state.v) {
      state = remote
      saveLocal()
      render()
      toast('Synced from peer')
    } else if (remote.v < state.v) {
      // Peer is behind — push ours back to them
      try { sendStateAction(state, peerId) } catch {}
    }
    // If v === v, assume same state; skip.
  })

  roomHandle.onPeerJoin(peerId => {
    peerCount++
    updatePeerCount()
    setConnStatus('online', 'Online')
    // New peer: send our state so they catch up
    try { sendStateAction(state, peerId) } catch {}
  })

  roomHandle.onPeerLeave(() => {
    peerCount = Math.max(0, peerCount - 1)
    updatePeerCount()
  })

  // Mark as online once the room is successfully constructed
  setConnStatus('online', peerCount > 0 ? 'Online' : 'Online (waiting for peers)')
}

function broadcastState() {
  if (sendStateAction) {
    try { sendStateAction(state) } catch (e) { console.warn('broadcast failed', e) }
  }
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
  broadcastState()
  render()
}

async function createRoom({ roomName, pin }) {
  const salt = uid()
  const pinHash = await sha256(pin + ':' + roomName + ':' + salt)
  state = initialState()
  state.roomId = roomName
  state.pinHash = pinHash
  state.pinSalt = salt
  state.createdAt = Date.now()
  state.updatedAt = state.createdAt
  state.v = 1
  localStorage.setItem(LS_PIN(roomName), pin)  // creator device caches PIN
  saveLocal()
  setRoomInURL(roomName)
  joinTrysteroRoom(roomName)
  render()
}

function addPlayer(name) {
  name = name.trim()
  if (!name) return
  if (state.players.some(p => p.name.toLowerCase() === name.toLowerCase())) {
    toast('Name already taken')
    return
  }
  mutate(s => {
    s.players.push({ id: uid(), name, joinedAt: Date.now() })
  })
  // Remember name for this device
  myName = name
  localStorage.setItem('cc:myName', name)
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

function setConnStatus(kind, label) {
  const dot = $('[data-role="conn-dot"]')
  const lab = $('[data-role="conn-label"]')
  dot.classList.remove('bg-sub', 'bg-volt', 'bg-amber', 'bg-danger', 'pulse-dot')
  if (kind === 'online')     { dot.classList.add('bg-volt', 'pulse-dot') }
  else if (kind === 'connecting') { dot.classList.add('bg-amber') }
  else                        { dot.classList.add('bg-sub') }
  lab.textContent = label
}

function updatePeerCount() {
  $('[data-role="peer-count"]').textContent = `${peerCount} ${peerCount === 1 ? 'peer' : 'peers'}`
}

function render() {
  if (!state.roomId) {
    showView('setup')
    $('[data-role="tabbar"]').classList.add('hidden')
    $('[data-role="share-btn"]').classList.add('hidden')
    $('[data-role="room-name"]').textContent = 'Carnage Courts'
    return
  }

  $('[data-role="tabbar"]').classList.remove('hidden')
  $('[data-role="share-btn"]').classList.remove('hidden')
  $('[data-role="room-name"]').textContent = state.roomId

  renderLobby()
  renderMatches()
  renderLeaderboard()

  // If we landed on setup view but have a room now, switch to lobby
  const anyVisible = $$('[data-view]').some(el => !el.classList.contains('hidden'))
  if (!anyVisible || $('[data-view="setup"]').offsetParent !== null) {
    showTab(currentTab || 'lobby')
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
  return params.get('room')
}

function setRoomInURL(roomId) {
  const url = new URL(location.href)
  url.searchParams.set('room', roomId)
  history.replaceState(null, '', url)
}

function clearRoomFromURL() {
  const url = new URL(location.href)
  url.searchParams.delete('room')
  history.replaceState(null, '', url)
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function wireSetup() {
  const nameInput = $('[data-role="new-room-name"]')
  const pinInput = $('[data-role="new-room-pin"]')
  nameInput.value = generateRoomName()

  $('[data-role="roll-room-name"]').onclick = () => { nameInput.value = generateRoomName() }

  $('[data-role="create-room"]').onclick = async () => {
    const roomName = nameInput.value.trim().replace(/\s+/g, '-')
    const pin = pinInput.value.trim()
    if (roomName.length < 3) { toast('Room name too short'); return }
    if (!/^\d{2}$/.test(pin)) { toast('PIN must be exactly 2 digits'); return }
    await createRoom({ roomName, pin })
    showTab('lobby')
  }

  $('[data-role="join-existing"]').onclick = () => {
    const entered = prompt('Enter existing room name:')
    if (entered) {
      setRoomInURL(entered.trim())
      location.reload()
    }
  }
}

function wireLobby() {
  $('[data-role="add-player-form"]').onsubmit = (e) => {
    e.preventDefault()
    const input = $('[data-role="add-player-name"]')
    const v = input.value
    if (!v.trim()) return
    addPlayer(v)
    input.value = ''
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
  wireSetup()
  wireLobby()
  wireMatches()
  wireTabs()
  wireShare()

  const urlRoom = getRoomFromURL()
  if (urlRoom) {
    const local = loadLocal(urlRoom)
    if (local) {
      state = local
    } else {
      // Empty shell until a peer sends us state
      state = initialState()
      state.roomId = urlRoom
    }
    joinTrysteroRoom(urlRoom)
    showTab('lobby')
  } else {
    showView('setup')
  }
  render()
}

boot()
