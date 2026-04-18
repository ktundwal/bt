import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateScore } from '../lib/scoring.mjs'

test('validateScore: typical win 21-17', () => {
  const r = validateScore(21, 17)
  assert.equal(r.ok, true)
  assert.equal(r.winner, 21)
  assert.equal(r.loser, 17)
  assert.equal(r.diff, 4)
})

test('validateScore: minimum valid win 21-20', () => {
  assert.equal(validateScore(21, 20).ok, true)
  assert.equal(validateScore(20, 21).ok, true)
})

test('validateScore: extended win 22-21 allowed (past 21 needs exactly +1)', () => {
  assert.equal(validateScore(22, 21).ok, true)
  assert.equal(validateScore(30, 29).ok, true)
})

test('validateScore: past 21 with margin > 1 rejected', () => {
  const r = validateScore(22, 20)
  assert.equal(r.ok, false)
  assert.match(r.reason, /exactly 1/)
})

test('validateScore: losing score >= 21 rejected', () => {
  // e.g. 21-22 is impossible since winner must be >= loser, but 25-21 is past-21 diff=4
  assert.equal(validateScore(25, 21).ok, false)
})

test('validateScore: winner below 21 rejected', () => {
  const r = validateScore(20, 15)
  assert.equal(r.ok, false)
  assert.match(r.reason, /21/)
})

test('validateScore: ties rejected', () => {
  assert.equal(validateScore(21, 21).ok, false)
  assert.equal(validateScore(0, 0).ok, false)
})

test('validateScore: negatives rejected', () => {
  assert.equal(validateScore(-1, 21).ok, false)
  assert.equal(validateScore(21, -1).ok, false)
})

test('validateScore: non-integers rejected', () => {
  assert.equal(validateScore(21.5, 17).ok, false)
  assert.equal(validateScore(NaN, 17).ok, false)
  assert.equal(validateScore('abc', 17).ok, false)
})

test('validateScore: string numerics coerced', () => {
  assert.equal(validateScore('21', '17').ok, true)
})
