import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Resvg } from '@resvg/resvg-js'
import type { Popularity } from './api.ts'
import type { MmrByHour } from './stats.ts'

/**
 * Chart images for /stats: drawn as SVG (pure, testable) and rendered to PNG
 * locally with resvg, using Balatro's pixel font (bundled, so no system fonts
 * are needed on the server).
 */

const FONT_FILE = fileURLToPath(new URL('../assets/fonts/m6x11.ttf', import.meta.url))
const FONT = 'm6x11'

const C = {
  background: '#1e1f22',
  grid: '#3a3c42',
  zero: '#6d6f78',
  text: '#dbdee1',
  muted: '#949ba4',
  gain: '#57f287',
  loss: '#ed4245',
  now: '#fee75c',
  busy: '#5865f2',
  deck: '#f5a623',
  stake: '#4aa8ff',
}

/** m6x11 has no '−' or '·', so the chart sticks to ASCII. */
const num = (v: number, digits = 1) => `${v < 0 ? '-' : '+'}${Math.abs(v).toFixed(digits)}`

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** A "nice" step for about `target` gridlines over `span` (1, 2 or 5 × 10ⁿ). */
function niceStep(span: number, target = 4): number {
  const raw = span / target
  const pow = 10 ** Math.floor(Math.log10(raw))
  return [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? 10 * pow
}

export const MMR_CHART = { width: 960, height: 440 }

/** Opacity for an hour with `games`, relative to the busiest hour: solid at the top, mostly transparent near zero. */
export function barOpacity(games: number, busiest: number): number {
  const MIN = 0.12
  return MIN + (1 - MIN) * Math.min(1, games / Math.max(1, busiest))
}

/**
 * Bar chart of MMR gained/lost per game for each hour: green above zero, red
 * below, fading out when based on few games; hours with too few games get a
 * grey dot; the current hour is highlighted with a "now" marker; the dashed
 * line is their overall average.
 */
export function mmrByHourSvg(t: MmrByHour, nowHour: number, timeZone: string): string {
  const { width: W, height: H } = MMR_CHART
  const pad = { left: 84, right: 28, top: 96, bottom: 64 }
  const plotW = W - pad.left - pad.right
  const plotH = H - pad.top - pad.bottom

  const values = t.hours.map((h) => h.mmr).filter((v): v is number => v !== null)
  let lo = Math.min(0, t.overall, ...values)
  let hi = Math.max(0, t.overall, ...values)
  if (hi - lo < 2) {
    // Nearly flat: keep some range so tiny differences don't look dramatic.
    hi += 1
    lo -= 1
  }
  const step = niceStep(hi - lo)
  lo = Math.floor(lo / step) * step
  hi = Math.ceil(hi / step) * step
  const y = (v: number) => pad.top + ((hi - v) / (hi - lo)) * plotH
  const slot = plotW / 24
  const x = (hour: number) => pad.left + hour * slot

  const out: string[] = []
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}">`)
  out.push(`<rect width="${W}" height="${H}" rx="18" fill="${C.background}"/>`)

  // Title and unit.
  out.push(`<text x="${pad.left}" y="44" font-size="32" fill="${C.text}">MMR per game by hour</text>`)
  out.push(`<text x="${pad.left}" y="72" font-size="16" fill="${C.muted}">${esc(timeZone)}  |  smoothed  |  solid = busiest hour, faint = few games</text>`)

  // Current hour: a band behind its column, and a marker above it.
  const nowX = x(nowHour)
  out.push(`<rect x="${nowX}" y="${pad.top - 8}" width="${slot}" height="${plotH + 16}" rx="6" fill="${C.now}" fill-opacity="0.12"/>`)
  out.push(`<text x="${nowX + slot / 2}" y="${pad.top - 14}" font-size="16" fill="${C.now}" text-anchor="middle">now</text>`)

  // Gridlines with labels.
  for (let v = lo; v <= hi + 1e-9; v += step) {
    const gy = y(v)
    const isZero = Math.abs(v) < 1e-9
    out.push(
      `<line x1="${pad.left}" x2="${W - pad.right}" y1="${gy}" y2="${gy}" stroke="${isZero ? C.zero : C.grid}" stroke-width="${isZero ? 2 : 1}"/>`
    )
    out.push(
      `<text x="${pad.left - 12}" y="${gy + 5}" font-size="16" fill="${C.muted}" text-anchor="end">${isZero ? '0' : num(v, Number.isInteger(v) ? 0 : 1)}</text>`
    )
  }

  // Bars. Opacity = how much they play at that hour, relative to their busiest hour.
  const busiest = Math.max(1, ...t.hours.map((h) => h.games))
  for (const h of t.hours) {
    const cx = x(h.hour) + slot / 2
    if (h.mmr === null) {
      out.push(`<circle cx="${cx}" cy="${y(0)}" r="3" fill="${C.muted}"/>`)
      continue
    }
    const top = Math.min(y(0), y(h.mmr))
    const height = Math.max(2, Math.abs(y(h.mmr) - y(0)))
    const opacity = barOpacity(h.games, busiest).toFixed(2)
    const color = h.mmr >= 0 ? C.gain : C.loss
    out.push(`<rect x="${x(h.hour) + slot * 0.15}" y="${top}" width="${slot * 0.7}" height="${height}" rx="3" fill="${color}" fill-opacity="${opacity}"/>`)
  }

  // Their overall average.
  const avgY = y(t.overall)
  out.push(`<line x1="${pad.left}" x2="${W - pad.right}" y1="${avgY}" y2="${avgY}" stroke="${C.muted}" stroke-width="2" stroke-dasharray="8 6"/>`)
  out.push(
    `<text x="${W - pad.right}" y="${avgY - 8}" font-size="16" fill="${C.muted}" text-anchor="end">avg ${num(t.overall)}</text>`
  )

  // Hours.
  for (let hour = 0; hour < 24; hour += 3) {
    out.push(
      `<text x="${x(hour) + slot / 2}" y="${H - pad.bottom + 32}" font-size="16" fill="${hour === nowHour ? C.now : C.muted}" text-anchor="middle">${hour}h</text>`
    )
  }
  if (nowHour % 3 !== 0) {
    out.push(`<text x="${nowX + slot / 2}" y="${H - pad.bottom + 32}" font-size="16" fill="${C.now}" text-anchor="middle">${nowHour}h</text>`)
  }

  out.push('</svg>')
  return out.join('\n')
}

// ------------------------------------------------------------ busiest hours

export const BUSY_CHART = { width: 960, height: 400 }

/**
 * Average games started per hour of the day (24 bars), the current hour
 * highlighted: when the queue is busiest.
 */
export function busiestHoursSvg(perHour: Array<number | null>, nowHour: number, timeZone: string, days: number): string {
  const { width: W, height: H } = BUSY_CHART
  const pad = { left: 84, right: 28, top: 96, bottom: 64 }
  const plotW = W - pad.left - pad.right
  const plotH = H - pad.top - pad.bottom
  const max = Math.max(1, ...perHour.map((v) => v ?? 0))
  const step = niceStep(max)
  const hi = Math.ceil(max / step) * step
  const y = (v: number) => pad.top + ((hi - v) / hi) * plotH
  const slot = plotW / 24
  const x = (hour: number) => pad.left + hour * slot

  const out: string[] = []
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}">`)
  out.push(`<rect width="${W}" height="${H}" rx="18" fill="${C.background}"/>`)
  out.push(`<text x="${pad.left}" y="44" font-size="32" fill="${C.text}">When the queue is busiest</text>`)
  out.push(
    `<text x="${pad.left}" y="72" font-size="16" fill="${C.muted}">${esc(timeZone)}  |  ranked matches started per hour, avg over ${days} day${days === 1 ? '' : 's'}</text>`
  )
  const nowX = x(nowHour)
  out.push(`<rect x="${nowX}" y="${pad.top - 8}" width="${slot}" height="${plotH + 16}" rx="6" fill="${C.now}" fill-opacity="0.12"/>`)
  out.push(`<text x="${nowX + slot / 2}" y="${pad.top - 14}" font-size="16" fill="${C.now}" text-anchor="middle">now</text>`)
  for (let v = 0; v <= hi + 1e-9; v += step) {
    const gy = y(v)
    out.push(`<line x1="${pad.left}" x2="${W - pad.right}" y1="${gy}" y2="${gy}" stroke="${v === 0 ? C.zero : C.grid}" stroke-width="${v === 0 ? 2 : 1}"/>`)
    out.push(`<text x="${pad.left - 12}" y="${gy + 5}" font-size="16" fill="${C.muted}" text-anchor="end">${Number.isInteger(step) ? v : v.toFixed(1)}</text>`)
  }
  perHour.forEach((v, hour) => {
    if (v === null) {
      out.push(`<circle cx="${x(hour) + slot / 2}" cy="${y(0)}" r="3" fill="${C.muted}"/>`)
      return
    }
    const height = Math.max(2, y(0) - y(v))
    out.push(`<rect x="${x(hour) + slot * 0.15}" y="${y(0) - height}" width="${slot * 0.7}" height="${height}" rx="3" fill="${C.busy}"/>`)
  })
  for (let hour = 0; hour < 24; hour += 3) {
    out.push(
      `<text x="${x(hour) + slot / 2}" y="${H - pad.bottom + 32}" font-size="16" fill="${hour === nowHour ? C.now : C.muted}" text-anchor="middle">${hour}h</text>`
    )
  }
  if (nowHour % 3 !== 0) {
    out.push(`<text x="${nowX + slot / 2}" y="${H - pad.bottom + 32}" font-size="16" fill="${C.now}" text-anchor="middle">${nowHour}h</text>`)
  }
  out.push('</svg>')
  return out.join('\n')
}

// --------------------------------------------------------------- popularity

const ASSETS = fileURLToPath(new URL('../assets/emoji/', import.meta.url))
const artCache = new Map<string, string | null>()

/** A deck's card art / stake chip as a data URI for embedding in the SVG (null if there's no image). */
function art(kind: 'deck' | 'stake', name: string): string | null {
  const key = `${kind}:${name}`
  if (!artCache.has(key)) {
    const file = join(ASSETS, kind === 'deck' ? 'decks' : 'stakes', `${name.toLowerCase()}.png`)
    artCache.set(key, existsSync(file) ? `data:image/png;base64,${readFileSync(file).toString('base64')}` : null)
  }
  return artCache.get(key)!
}

const titleCase = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase())

/**
 * Pick rates as horizontal bars, most picked first, with each deck's card
 * art / stake chip; the bar shows the pick rate, the label the game count.
 */
export function popularitySvg(kind: 'deck' | 'stake', items: Popularity[], season: string): string {
  const rows = [...items].sort((a, b) => b.pickRate - a.pickRate)
  const rowH = kind === 'deck' ? 44 : 40
  const W = 960
  const pad = { left: 250, right: 150, top: 96, bottom: 28 }
  const H = pad.top + rows.length * rowH + pad.bottom
  const plotW = W - pad.left - pad.right
  const max = Math.max(1, ...rows.map((r) => r.pickRate))
  const color = kind === 'deck' ? C.deck : C.stake
  const total = rows.reduce((sum, r) => sum + r.games, 0)

  const out: string[] = []
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}">`)
  out.push(`<rect width="${W}" height="${H}" rx="18" fill="${C.background}"/>`)
  out.push(`<text x="40" y="44" font-size="32" fill="${C.text}">${kind === 'deck' ? 'Most picked decks' : 'Most picked stakes'}</text>`)
  out.push(
    `<text x="40" y="72" font-size="16" fill="${C.muted}">Ranked  |  ${esc(season.replace('season', 'season '))}  |  ${total.toLocaleString('en-US')} ${kind} picks</text>`
  )
  rows.forEach((r, i) => {
    const top = pad.top + i * rowH
    const mid = top + rowH / 2
    const image = art(kind, r.name)
    if (image) {
      const [w, h] = kind === 'deck' ? [27, 36] : [30, 30]
      out.push(`<image x="40" y="${mid - h / 2}" width="${w}" height="${h}" href="${image}" xlink:href="${image}"/>`)
    }
    out.push(`<text x="84" y="${mid + 6}" font-size="16" fill="${C.text}">${esc(titleCase(r.name))}</text>`)
    const barW = Math.max(3, (r.pickRate / max) * plotW)
    out.push(`<rect x="${pad.left}" y="${mid - 11}" width="${plotW}" height="22" rx="4" fill="${C.grid}" fill-opacity="0.35"/>`)
    out.push(`<rect x="${pad.left}" y="${mid - 11}" width="${barW}" height="22" rx="4" fill="${color}"/>`)
    out.push(
      `<text x="${pad.left + plotW + 14}" y="${mid + 6}" font-size="16" fill="${C.text}">${r.pickRate.toFixed(1)}%</text>`,
      `<text x="${W - 24}" y="${mid + 6}" font-size="16" fill="${C.muted}" text-anchor="end">${r.games.toLocaleString('en-US')}</text>`
    )
  })
  out.push('</svg>')
  return out.join('\n')
}

/** Renders an SVG to PNG with the bundled font. */
export function renderPng(svg: string): Buffer {
  const resvg = new Resvg(svg, {
    font: { fontFiles: [FONT_FILE], loadSystemFonts: false, defaultFontFamily: FONT },
  })
  return resvg.render().asPng()
}
