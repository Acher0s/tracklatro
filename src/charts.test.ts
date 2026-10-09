import assert from 'node:assert/strict'
import { test } from 'node:test'
import { barOpacity, MMR_CHART, mmrByHourSvg, renderPng } from './charts.ts'
import type { MmrByHour } from './stats.ts'

const data: MmrByHour = {
  overall: 2.5,
  games: 500,
  hours: Array.from({ length: 24 }, (_, hour) => ({
    hour,
    games: 20,
    pooled: hour === 4 ? 3 : 60,
    mmr: hour === 4 ? null : hour === 15 ? -1.6 : 1 + (hour % 5),
  })),
}

test('one bar per hour (a dot for hours with too few games), gains green and losses red', () => {
  const svg = mmrByHourSvg(data, 22, 'Europe/Brussels')
  const bars = svg.match(/<rect x="[\d.]+" y="[\d.]+" width="[\d.]+" height="[\d.]+" rx="3" fill="#(57f287|ed4245)"/g) ?? []
  assert.equal(bars.length, 23)
  assert.equal(bars.filter((b) => b.includes('#ed4245')).length, 1)
  assert.equal((svg.match(/<circle /g) ?? []).length, 1)
  assert.match(svg, />now</)
  assert.match(svg, />22h</) // current hour labelled even off the 3-hour grid
})

test('bar opacity: solid for the busiest hour, mostly transparent for few games', () => {
  assert.equal(barOpacity(80, 80), 1)
  assert.ok(barOpacity(8, 80) < 0.25) // a tenth of the busiest hour
  assert.ok(barOpacity(40, 80) > 0.5 && barOpacity(40, 80) < 0.6)
  assert.equal(barOpacity(0, 80), 0.12) // never fully invisible
  // Relative to this player's own busiest hour, not a fixed number of games.
  assert.equal(barOpacity(8, 8), 1)
  const svg = mmrByHourSvg(
    { ...data, hours: data.hours.map((h) => ({ ...h, games: h.hour === 10 ? 100 : 10 })) },
    0,
    'UTC'
  )
  const opacities = [...svg.matchAll(/rx="3" fill="#[0-9a-f]+" fill-opacity="([\d.]+)"/g)].map((m) => Number(m[1]))
  assert.equal(Math.max(...opacities), 1)
  assert.ok(Math.min(...opacities) < 0.25)
})

test('chart text only uses characters the pixel font has', () => {
  const svg = mmrByHourSvg({ ...data, overall: -3.25 }, 5, 'America/Argentina/Buenos_Aires')
  const texts = [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]!)
  for (const t of texts) assert.match(t, /^[\x20-\x7e]*$/, `non-ASCII in chart text: ${t}`)
  assert.ok(texts.includes('avg -3.3'))
})

test('renders to a PNG of the chart size', () => {
  const png = renderPng(mmrByHourSvg(data, 0, 'UTC'))
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  assert.equal(png.readUInt32BE(16), MMR_CHART.width)
  assert.equal(png.readUInt32BE(20), MMR_CHART.height)
})
