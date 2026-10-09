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
