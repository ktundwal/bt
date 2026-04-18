// Round-robin scheduler (circle method) and helpers.
// Pure functions, no DOM or storage deps — safe to unit-test in Node.

export function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function hashString(s) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

export function shuffled(arr, seed) {
  const out = arr.slice()
  const rng = mulberry32(seed)
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

const ADJECTIVES = [
  'Sweaty', 'Feral', 'Unhinged', 'Rabid', 'Concussed', 'Tragic', 'Cursed',
  'Wounded', 'Mediocre', 'Delusional', 'Cramping', 'Overconfident', 'Breathless',
  'Sketchy', 'Discount', 'Washed', 'Caffeinated', 'Wobbly', 'Reckless', 'Grizzled',
  'Squeaky', 'Geriatric', 'Limping', 'Hungover', 'Underdressed'
]

const NOUNS = [
  'Shuttlecocks', 'Birdies', 'Smashers', 'Hamstrings', 'Peacocks', 'Flamingos',
  'Gremlins', 'Weekenders', 'Lycra-Abusers', 'Knees', 'Gladiators', 'Warriors',
  'Divas', 'Regrets', 'Pensioners', 'Crampons', 'Understudies', 'Bandits',
  'Nightmares', 'Legends', 'Menaces', 'Raccoons', 'Meerkats', 'Pigeons', 'Mongooses'
]

const pickFrom = (arr, rng) => arr[Math.floor(rng() * arr.length)]

export function generateRoomName(now = Date.now()) {
  const rng = mulberry32(now >>> 0)
  return `${pickFrom(ADJECTIVES, rng)}-${pickFrom(NOUNS, rng)}-${Math.floor(rng() * 90 + 10)}`
}

export function generateTeamName(playerIds) {
  const seed = hashString(playerIds.slice().sort().join('|'))
  const rng = mulberry32(seed)
  return `${pickFrom(ADJECTIVES, rng)} ${pickFrom(NOUNS, rng)}`
}

// Unique-ish id generator; callers can substitute for deterministic tests
const defaultUid = () => Math.random().toString(36).slice(2, 10)

/**
 * Build a round-robin schedule using the circle method.
 * - Every pair plays exactly once.
 * - Odd team counts get a BYE (that team sits out one round).
 * - Matches within a round are packed onto courts; overflow becomes
 *   subsequent "waves" (same round, staggered court assignment).
 *
 * @param {Array<{id:string,name:string,playerIds:string[]}>} teams
 * @param {number} courts - max concurrent courts (>=1)
 * @param {() => string} [uid] - id generator for tests
 */
export function buildSchedule(teams, courts, uid = defaultUid) {
  if (!Array.isArray(teams) || teams.length < 2) return []
  if (!Number.isInteger(courts) || courts < 1) throw new Error('courts must be a positive integer')

  const list = teams.slice()
  const hasBye = list.length % 2 === 1
  if (hasBye) list.push({ id: '__BYE__', name: 'BYE', playerIds: [] })

  const n = list.length
  const rounds = n - 1
  const half = n / 2
  const matches = []
  const ids = list.map(t => t.id)

  for (let r = 0; r < rounds; r++) {
    const roundMatches = []
    for (let i = 0; i < half; i++) {
      const a = ids[i]
      const b = ids[n - 1 - i]
      if (a === '__BYE__' || b === '__BYE__') continue
      roundMatches.push({ teamAId: a, teamBId: b })
    }
    roundMatches.forEach((m, idx) => {
      matches.push({
        id: uid(),
        round: r + 1,
        wave: Math.floor(idx / courts) + 1,
        court: (idx % courts) + 1,
        teamAId: m.teamAId,
        teamBId: m.teamBId,
        scoreA: null,
        scoreB: null,
        done: false
      })
    })
    // Rotate — keep ids[0] fixed, rotate the rest by one
    const fixed = ids[0]
    const rest = ids.slice(1)
    rest.unshift(rest.pop())
    ids.splice(0, ids.length, fixed, ...rest)
  }

  return matches
}
