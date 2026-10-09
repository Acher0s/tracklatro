import { fileURLToPath } from 'node:url'
import { Resvg } from '@resvg/resvg-js'
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

/** Renders an SVG to PNG with the bundled font. */
export function renderPng(svg: string): Buffer {
  const resvg = new Resvg(svg, {
    font: { fontFiles: [FONT_FILE], loadSystemFonts: false, defaultFontFamily: FONT },
  })
  return resvg.render().asPng()
}
