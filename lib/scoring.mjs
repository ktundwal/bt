// Scoring validation for badminton matches.
// Rule: first to 21, win by exactly 1 (so 21-20 and 22-21 are valid; 22-20 is not).

export function validateScore(a, b) {
  const A = Number(a), B = Number(b)
  if (!Number.isFinite(A) || !Number.isFinite(B)) return { ok: false, reason: 'Scores must be numbers' }
  if (!Number.isInteger(A) || !Number.isInteger(B)) return { ok: false, reason: 'Scores must be whole numbers' }
  if (A < 0 || B < 0) return { ok: false, reason: 'Scores must be non-negative' }
  if (A === B) return { ok: false, reason: 'Ties are for losers. Play it out.' }
  const winner = Math.max(A, B)
  const loser = Math.min(A, B)
  if (winner < 21) return { ok: false, reason: 'Winner must reach 21' }
  if (winner > 21 && winner - loser !== 1) return { ok: false, reason: 'Past 21, must win by exactly 1' }
  return { ok: true, winner, loser, diff: winner - loser }
}
