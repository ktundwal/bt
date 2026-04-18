import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildSchedule,
  generateRoomName,
  generateTeamName,
  mulberry32,
  hashString,
  shuffled
} from '../lib/scheduler.mjs'

// Deterministic uid factory for tests
const makeUid = () => {
  let n = 0
  return () => `m${++n}`
}

function mkTeams(n) {
  return Array.from({ length: n }, (_, i) => ({ id: `T${i}`, name: `T${i}`, playerIds: [`p${i}a`, `p${i}b`] }))
}

function pairKey(a, b) { return [a, b].sort().join('|') }

test('buildSchedule: every pair plays exactly once across N=4..12 and courts=1..4', () => {
  for (let n = 4; n <= 12; n++) {
    for (let courts = 1; courts <= 4; courts++) {
      const teams = mkTeams(n)
      const matches = buildSchedule(teams, courts, makeUid())
      const seen = new Map()
      for (const m of matches) {
        const k = pairKey(m.teamAId, m.teamBId)
        seen.set(k, (seen.get(k) || 0) + 1)
      }
      const expectedPairs = n * (n - 1) / 2
      assert.equal(seen.size, expectedPairs, `N=${n} courts=${courts}: pair count`)
      for (const v of seen.values()) assert.equal(v, 1, `N=${n} courts=${courts}: duplicate pair`)
    }
  }
})

test('buildSchedule: each team plays exactly N-1 matches', () => {
  for (const n of [4, 5, 6, 7, 8, 10, 12]) {
    const matches = buildSchedule(mkTeams(n), 4, makeUid())
    const counts = new Map()
    for (const m of matches) {
      counts.set(m.teamAId, (counts.get(m.teamAId) || 0) + 1)
      counts.set(m.teamBId, (counts.get(m.teamBId) || 0) + 1)
    }
    assert.equal(counts.size, n, `N=${n}: every team appears`)
    for (const [id, c] of counts) assert.equal(c, n - 1, `N=${n}: team ${id} plays ${c}, expected ${n - 1}`)
  }
})

test('buildSchedule: no team plays twice in the same round+wave', () => {
  for (const n of [4, 5, 6, 8, 10]) {
    for (const courts of [1, 2, 3, 4]) {
      const matches = buildSchedule(mkTeams(n), courts, makeUid())
      const bucket = new Map()
      for (const m of matches) {
        const k = `${m.round}|${m.wave}`
        if (!bucket.has(k)) bucket.set(k, new Set())
        const s = bucket.get(k)
        assert.ok(!s.has(m.teamAId), `N=${n} c=${courts}: team ${m.teamAId} double-booked in round ${m.round} wave ${m.wave}`)
        assert.ok(!s.has(m.teamBId), `N=${n} c=${courts}: team ${m.teamBId} double-booked in round ${m.round} wave ${m.wave}`)
        s.add(m.teamAId); s.add(m.teamBId)
      }
    }
  }
})

test('buildSchedule: no court exceeds the configured cap', () => {
  for (const courts of [1, 2, 3, 4, 6, 8]) {
    const matches = buildSchedule(mkTeams(10), courts, makeUid())
    for (const m of matches) {
      assert.ok(m.court >= 1 && m.court <= courts, `court ${m.court} outside 1..${courts}`)
      assert.ok(m.wave >= 1, `wave ${m.wave} must be >=1`)
    }
  }
})

test('buildSchedule: odd team count produces correct round-robin via BYE', () => {
  const n = 5
  const matches = buildSchedule(mkTeams(n), 2, makeUid())
  // 5 teams → C(5,2)=10 matches, 5 rounds
  assert.equal(matches.length, 10)
  const rounds = new Set(matches.map(m => m.round))
  assert.equal(rounds.size, 5)
  // No BYE marker leaks into output
  for (const m of matches) {
    assert.notEqual(m.teamAId, '__BYE__')
    assert.notEqual(m.teamBId, '__BYE__')
  }
})

test('buildSchedule: returns empty for <2 teams', () => {
  assert.deepEqual(buildSchedule([], 4, makeUid()), [])
  assert.deepEqual(buildSchedule(mkTeams(1), 4, makeUid()), [])
})

test('buildSchedule: rejects invalid court counts', () => {
  assert.throws(() => buildSchedule(mkTeams(4), 0, makeUid()))
  assert.throws(() => buildSchedule(mkTeams(4), -1, makeUid()))
  assert.throws(() => buildSchedule(mkTeams(4), 1.5, makeUid()))
})

test('generateRoomName: deterministic for a given timestamp seed', () => {
  const a = generateRoomName(123456)
  const b = generateRoomName(123456)
  assert.equal(a, b)
  assert.match(a, /^[A-Z][a-z]+-[A-Z][a-z-]+-\d{2}$/)
})

test('generateTeamName: stable across player-id order', () => {
  const a = generateTeamName(['alice', 'bob'])
  const b = generateTeamName(['bob', 'alice'])
  assert.equal(a, b, 'team name must not depend on input order')
})

test('mulberry32: deterministic and in [0,1)', () => {
  const rng = mulberry32(42)
  const seq1 = Array.from({ length: 5 }, () => rng())
  const rng2 = mulberry32(42)
  const seq2 = Array.from({ length: 5 }, () => rng2())
  assert.deepEqual(seq1, seq2)
  for (const v of seq1) assert.ok(v >= 0 && v < 1)
})

test('hashString: stable and not trivially zero', () => {
  assert.equal(hashString('hello'), hashString('hello'))
  assert.notEqual(hashString('hello'), hashString('world'))
  assert.notEqual(hashString('abc'), 0)
})

test('shuffled: preserves elements and is deterministic per seed', () => {
  const arr = [1, 2, 3, 4, 5, 6, 7, 8]
  const a = shuffled(arr, 99)
  const b = shuffled(arr, 99)
  assert.deepEqual(a, b)
  assert.deepEqual(a.slice().sort((x, y) => x - y), arr)
})
