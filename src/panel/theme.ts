/**
 * Follow Premiere's UI brightness (Preferences ▸ Appearance). CEP reports the
 * panel background colour; the other surface tokens in css/panel.css are
 * derived from it so cards, fields and lines keep their contrast at any
 * brightness. Outside CEP the stylesheet's dark defaults stand.
 */
type Rgb = [number, number, number]

interface SkinInfo {
  panelBackgroundColor?: { color?: { red: number; green: number; blue: number } }
  baseFontFamily?: string
  baseFontSize?: number
}

interface CSInterfaceLike {
  getHostEnvironment(): { appSkinInfo?: SkinInfo }
  addEventListener(type: string, listener: () => void): void
}

declare const CSInterface: { new (): CSInterfaceLike } | undefined

const THEME_EVENT = 'com.adobe.csxs.events.ThemeColorChanged'

function hex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`
}

function shift(c: Rgb, d: number): Rgb {
  return [c[0] + d, c[1] + d, c[2] + d]
}

export function applyTheme(bg: Rgb): void {
  const lum = (0.2126 * bg[0] + 0.7152 * bg[1] + 0.0722 * bg[2]) / 255
  const light = lum > 0.5
  // On light backgrounds surfaces go darker, not lighter, to stay visible.
  const s = light ? -1 : 1
  const vars: Record<string, string> = {
    '--bg': hex(bg),
    '--surface': hex(shift(bg, 7 * s)),
    '--surface-2': hex(shift(bg, 16 * s)),
    '--field': hex(shift(bg, light ? 18 : -8)),
    '--line': hex(shift(bg, 24 * s)),
    '--line-strong': hex(shift(bg, 42 * s)),
    '--text': light ? '#1f1f1f' : '#dadada',
    '--text-2': light ? '#444444' : '#a8a8a8',
    '--muted': light ? '#666666' : '#7d7d7d',
  }
  const root = document.documentElement.style
  for (const [k, v] of Object.entries(vars)) root.setProperty(k, v)
}

function readSkin(cs: CSInterfaceLike): void {
  const skin = cs.getHostEnvironment().appSkinInfo
  const c = skin?.panelBackgroundColor?.color
  if (c) applyTheme([c.red, c.green, c.blue])
  if (skin?.baseFontFamily) {
    document.documentElement.style.setProperty('--font', `"${skin.baseFontFamily}", "Adobe Clean", "Segoe UI", system-ui, sans-serif`)
  }
}

export function syncWithHost(): void {
  const inCep = typeof (window as unknown as { __adobe_cep__?: unknown }).__adobe_cep__ !== 'undefined'
  if (!inCep || typeof CSInterface !== 'function') return
  const cs = new CSInterface()
  try {
    readSkin(cs)
    cs.addEventListener(THEME_EVENT, () => readSkin(cs))
  } catch {
    // Older hosts without skin info keep the stylesheet defaults.
  }
}
