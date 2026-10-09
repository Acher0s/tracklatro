/**
 * Time zones for /timezone. Discord doesn't tell bots a user's time zone, so
 * users pick one; suggestions show each zone's current local time so they can
 * just pick the one matching their clock.
 */

const ALL_ZONES: string[] = ['UTC', ...Intl.supportedValuesOf('timeZone').filter((z) => z !== 'UTC')]

export function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

/** "21:14" in a time zone. */
export function localTime(zone: string, now = Date.now()): string {
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: zone }).format(now)
}

/**
 * Likely zones for a Discord locale, only to order suggestions (a language
 * says little about where someone is; the user still picks).
 */
const LOCALE_GUESSES: Record<string, string[]> = {
  nl: ['Europe/Amsterdam', 'Europe/Brussels'],
  fr: ['Europe/Paris', 'Europe/Brussels', 'America/Toronto'],
  de: ['Europe/Berlin', 'Europe/Vienna', 'Europe/Zurich'],
  'en-GB': ['Europe/London', 'Europe/Dublin'],
  'en-US': ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles'],
  'es-ES': ['Europe/Madrid'],
  'es-419': ['America/Mexico_City', 'America/Bogota', 'America/Argentina/Buenos_Aires'],
  'pt-BR': ['America/Sao_Paulo'],
  it: ['Europe/Rome'],
  pl: ['Europe/Warsaw'],
  sv: ['Europe/Stockholm'],
  da: ['Europe/Copenhagen'],
  no: ['Europe/Oslo'],
  fi: ['Europe/Helsinki'],
  ru: ['Europe/Moscow'],
  uk: ['Europe/Kyiv'],
  tr: ['Europe/Istanbul'],
  ja: ['Asia/Tokyo'],
  ko: ['Asia/Seoul'],
  'zh-CN': ['Asia/Shanghai'],
  'zh-TW': ['Asia/Taipei'],
}

/** A zone's current UTC offset in minutes (120 for CEST); follows daylight saving. */
export function utcOffsetMinutes(zone: string, now = Date.now()): number {
  const name =
    new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' })
      .formatToParts(now)
      .find((p) => p.type === 'timeZoneName')?.value ?? 'GMT'
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(name)
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0
}

/** "UTC+2", "UTC-3:30", "UTC". */
export function offsetLabel(minutes: number): string {
  if (minutes === 0) return 'UTC'
  const abs = Math.abs(minutes)
  return `UTC${minutes < 0 ? '-' : '+'}${Math.floor(abs / 60)}${abs % 60 ? `:${String(abs % 60).padStart(2, '0')}` : ''}`
}

/** Well-known cities, preferred as the zone for their offset. */
const REPRESENTATIVES = [
  'Pacific/Honolulu', 'America/Anchorage', 'America/Los_Angeles', 'America/Denver', 'America/Chicago',
  'America/New_York', 'America/Halifax', 'America/Sao_Paulo', 'America/Argentina/Buenos_Aires',
  'Atlantic/South_Georgia', 'Atlantic/Azores', 'Europe/London', 'Europe/Brussels', 'Europe/Paris',
  'Europe/Berlin', 'Europe/Athens', 'Europe/Helsinki', 'Europe/Istanbul', 'Europe/Moscow', 'Asia/Dubai',
  'Asia/Karachi', 'Asia/Kolkata', 'Asia/Calcutta', 'Asia/Dhaka', 'Asia/Bangkok', 'Asia/Shanghai', 'Asia/Singapore',
  'Asia/Tokyo', 'Australia/Brisbane', 'Australia/Sydney', 'Pacific/Noumea', 'Pacific/Auckland',
  'Pacific/Tongatapu',
]

/**
 * One choice per current UTC offset, for a "what time is it for you?" picker:
 * whole hours from UTC-10 to UTC+13 plus India's UTC+5:30 (25, Discord's
 * maximum), each as a real zone (so daylight saving keeps working), preferring
 * zones that fit the user's Discord language, then well-known cities.
 */
export function quickPickZones(
  locale: string | undefined,
  now = Date.now()
): Array<{ label: string; description: string; value: string }> {
  const byOffset = new Map<number, string[]>()
  for (const zone of ALL_ZONES) {
    if (!zone.includes('/') || zone.startsWith('Etc/')) continue
    const offset = utcOffsetMinutes(zone, now)
    const list = byOffset.get(offset) ?? []
    list.push(zone)
    byOffset.set(offset, list)
  }
  const guesses = (locale && (LOCALE_GUESSES[locale] ?? LOCALE_GUESSES[locale.split('-')[0]!])) || []
  const offsets = [...Array.from({ length: 24 }, (_, i) => (i - 10) * 60), 330].sort((a, b) => a - b)
  const out: Array<{ label: string; description: string; value: string }> = []
  for (const offset of offsets) {
    const zones = byOffset.get(offset)
    if (!zones?.length) continue
    const zone =
      guesses.find((z) => zones.includes(z)) ?? REPRESENTATIVES.find((z) => zones.includes(z)) ?? zones[0]!
    const city = (zone.split('/').at(-1) ?? zone).replace(/_/g, ' ')
    out.push({ label: `${localTime(zone, now)} · ${city}`, description: `${offsetLabel(offset)} · ${zone}`, value: zone })
  }
  return out
}

/** Up to 25 autocomplete choices: matches for what's typed, or guesses for the locale. */
export function suggestTimeZones(query: string, locale: string | undefined, now = Date.now()): Array<{ name: string; value: string }> {
  const q = query.trim().toLowerCase().replace(/[\s_]+/g, ' ')
  let zones: string[]
  if (q) {
    const matches = ALL_ZONES.filter((z) => z.toLowerCase().replace(/_/g, ' ').includes(q))
    // Prefer matches on the city (after the last "/").
    const city = (z: string) => (z.split('/').at(-1) ?? z).toLowerCase().replace(/_/g, ' ')
    zones = [...matches.filter((z) => city(z).startsWith(q)), ...matches.filter((z) => !city(z).startsWith(q))]
  } else {
    const guesses = (locale && (LOCALE_GUESSES[locale] ?? LOCALE_GUESSES[locale.split('-')[0]!])) || []
    zones = [...new Set([...guesses, 'UTC', 'Europe/London', 'Europe/Brussels', 'America/New_York', 'America/Los_Angeles', 'Asia/Tokyo'])]
  }
  return zones.slice(0, 25).map((zone) => ({ name: `${zone.replace(/_/g, ' ')} (now ${localTime(zone, now)})`, value: zone }))
}
