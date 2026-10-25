/**
 * Update check, same scheme as Syncitol: once a day ask GitHub for the latest
 * release and show a banner when it is newer than the running version.
 *
 * The repo must stay public: GitHub answers 404 to an anonymous request for a
 * private repo's releases.
 *
 * Everything fails quietly (offline, rate-limited, odd tag): the panel says
 * nothing and tries again tomorrow. Clicking the version forces a check and
 * reports either way.
 */

import { openExternal } from './host.ts'
import { log } from './log.ts'

declare const __PROMATCH_VERSION__: string

export const VERSION = __PROMATCH_VERSION__

const REPO = 'thinkvp/ProMatch'
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`
const PAGE_URL = `https://github.com/${REPO}/releases/latest`
const LAST_CHECK_KEY = 'promatch-update-last-check'
const DISMISSED_KEY = 'promatch-update-dismissed'
const INTERVAL_MS = 24 * 60 * 60 * 1000
const TIMEOUT_MS = 10000

function lsGet(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}
function lsSet(key: string, value: string): void {
  try { localStorage.setItem(key, value) } catch { /* private mode etc. */ }
}

/** -1 / 0 / 1 like a comparator, or null when either isn't x.y.z. */
export function compareVersions(a: string | null, b: string | null): number | null {
  const parts = (v: string | null) => {
    const m = /^\s*v?(\d+)\.(\d+)\.(\d+)/.exec(v ?? '')
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
  }
  const pa = parts(a)
  const pb = parts(b)
  if (!pa || !pb) return null
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1
  return 0
}

export function initUpdates(card: HTMLElement, versionLink: HTMLElement): void {
  const text = card.querySelector<HTMLElement>('.update-text')!
  let releaseUrl = PAGE_URL
  let latest: string | null = null

  versionLink.textContent = `v${VERSION}`

  // `manual` = the user asked: report either way, ignore the throttle and a dismissal.
  async function check(manual: boolean): Promise<void> {
    const last = Number(lsGet(LAST_CHECK_KEY) || 0)
    if (!manual && last && Date.now() - last < INTERVAL_MS) return
    // Stamp before the request: a network that is down shouldn't mean a retry on every open.
    lsSet(LAST_CHECK_KEY, String(Date.now()))

    let tag: string | null = null
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
      const res = await fetch(API_URL, { headers: { Accept: 'application/vnd.github+json' }, signal: ctrl.signal })
      clearTimeout(timer)
      if (!res.ok) throw new Error(`GitHub replied ${res.status}`)
      const data = await res.json()
      tag = data?.tag_name ?? null
      if (data?.html_url) releaseUrl = data.html_url
    } catch (e) {
      if (manual) {
        log(`Could not check for updates: ${(e as Error)?.message ?? e}. Opening the releases page instead.`, 'warn')
        openExternal(PAGE_URL)
      }
      return
    }

    const diff = compareVersions(tag, VERSION)
    if (diff === null) {
      if (manual) log('Could not read the latest release number from GitHub.', 'warn')
      return
    }
    if (diff <= 0) {
      if (manual) log(`ProMatch v${VERSION} is up to date.`)
      return
    }
    latest = String(tag).replace(/^v/, '')
    if (!manual && lsGet(DISMISSED_KEY) === latest) return
    text.textContent = `ProMatch v${latest} is available (you have v${VERSION}).`
    card.hidden = false
    log(`ProMatch v${latest} is available (you have v${VERSION}).`)
  }

  card.querySelector('.update-open')!.addEventListener('click', () => openExternal(releaseUrl))
  card.querySelector('.update-close')!.addEventListener('click', () => {
    if (latest) lsSet(DISMISSED_KEY, latest)
    card.hidden = true
  })
  versionLink.addEventListener('click', (e) => {
    e.preventDefault()
    log('Checking for a newer release…')
    check(true)
  })
  check(false).catch(() => {})
}
