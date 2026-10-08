import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Api, SiteGame, SiteSeason } from './api.ts'
import { findResult, fromSite, ResultSource } from './results.ts'
import type { TrackedMatch } from './tracker.ts'

const game = (gameId: number, gameTime: string, opponentId: string, result: 'win' | 'loss' = 'win'): SiteGame => ({
  playerId: 'a',
  gameId,
  gameTime,
  opponentId,
  opponentName: opponentId,
  mmrChange: result === 'win' ? 12.2 : -12.2,
  result,
  deck: 'Yellow Deck',
  stake: 'Spectral+ Stake',
})

const match: TrackedMatch = {
  players: ['a', 'b'],
  startTime: Date.parse('2026-10-08T10:00:00Z'),
  endedAt: Date.parse('2026-10-08T10:25:00Z'),
  detectedAt: 0,
  late: false,
  unseenQueue: new Set(),
  queueJoins: new Map(),
}

test('findResult picks the game against the opponent within the match lifetime', () => {
  const history = [
    game(5, '2026-10-08T10:27:00Z', 'b', 'loss'), // instant rematch, still running: the site already calls it a loss
    game(4, '2026-10-08T10:00:01Z', 'b'),
    game(3, '2026-10-08T09:30:00Z', 'b'), // earlier game vs the same opponent
    game(2, '2026-10-08T10:00:05Z', 'c'),
  ].map(fromSite)
  const r = findResult(history, match)
  assert.equal(r?.matchId, 4)
  assert.equal(r?.won, true)
  assert.equal(r?.deck, 'Yellow Deck')
  assert.equal(r?.stake, 'Spectral+ Stake')
  assert.equal(findResult([fromSite(game(3, '2026-10-08T09:30:00Z', 'b'))], match), null) // cancelled
})

test('ResultSource asks the site for the active season, once', async () => {
  const calls: string[] = []
  const api = {
    fetchSeasons: async (): Promise<SiteSeason[]> => {
      calls.push('seasons')
      return [
        { id: 6, name: 'Season 6', startDate: '2026-02-27T18:00:00Z', endDate: '2026-07-01T17:00:00Z', isActive: false },
        { id: 7, name: 'Season 7', startDate: '2026-07-01T17:00:00Z', endDate: null, isActive: true },
      ]
    },
    fetchMatchHistory: async (userId: string, season: string, pageSize: number) => {
      calls.push(`history ${userId} ${season} ${pageSize}`)
      return [game(4, '2026-10-08T10:00:01Z', 'b')]
    },
  } as unknown as Api
  const source = new ResultSource(api)
  assert.equal((await source.history('a'))[0]?.matchId, 4)
  await source.history('a')
  assert.deepEqual(calls, ['seasons', 'history a season7 3', 'history a season7 3'])
})
