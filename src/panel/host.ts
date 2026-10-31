/**
 * Typed bridge to jsx/host.jsx (same transport as Interviewed: the argument
 * is JSON-stringified twice so it arrives as a safe JS string literal).
 *
 * Outside CEP (the panel opened in a plain browser for UI work) there is no
 * CSInterface; `available` is false and every call rejects with a clear
 * message instead of hanging.
 */

import type { ColourSetup } from '../core/calibrate.ts'

interface CSInterfaceLike {
  evalScript(script: string, callback: (result: string) => void): void
  getSystemPath(type: string): string
}

declare const CSInterface: { new (): CSInterfaceLike } | undefined
declare const SystemPath: { EXTENSION: string } | undefined

export interface CaptureInfo {
  timecode: string
  sequence: string
  width: number
  height: number
  clip: CaptureClip | null
}

/** The clip a capture shows, with what was on it then. */
export interface CaptureClip {
  name: string
  track: number
  multicam: boolean
  /** Its effects in order (display names), without Opacity, Motion and ProMatch. */
  effects?: string[]
  /** Lumetri vignette amount when one is switched on, else null. */
  vignette?: number | null
  /** The media's colour space; scene-referred = log or raw. */
  media?: { name: string; sceneReferred: boolean } | null
  /** Captured alone: its ProMatch effects at 0% and the tracks above it hidden for the capture. */
  raw?: boolean
  /** Tracks (V numbers) hidden for the capture. */
  hidden?: number[]
  /** Its own track was hidden, so shown for the capture. */
  shown?: boolean
  /** ProMatch effects set to 0% for the capture. */
  bypassed?: number
}

export interface SelectedClip {
  name: string
  track: number
  hasLumetri: boolean
}

export interface ParamValue {
  type: string
  value: string
  length?: number
  /** First char codes in hex — blob params read back as odd strings. */
  codes?: string
}

export interface EffectDump {
  clip: string
  components: Array<{ index: number; name: string; matchName: string; props: Array<ParamValue & { index: number; name: string }> }>
}

export interface LutSpike {
  clip: string
  tried: Array<{ index: number; name: string; before: ParamValue; after: ParamValue; error: string | null }>
}

// CSInterface.js defines its class anywhere; only CEP injects __adobe_cep__.
const inCep = typeof (window as unknown as { __adobe_cep__?: unknown }).__adobe_cep__ !== 'undefined'
const cs: CSInterfaceLike | null = inCep && typeof CSInterface === 'function' ? new CSInterface() : null

export const available = cs !== null

function evalRaw(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!cs) {
      reject(new Error('Not running inside Premiere Pro.'))
      return
    }
    cs.evalScript(script, resolve)
  })
}

async function call<T>(fn: string, arg?: unknown): Promise<T> {
  const script = arg === undefined ? `${fn}()` : `${fn}(${JSON.stringify(JSON.stringify(arg))})`
  const raw = await evalRaw(script)
  if (raw === 'EvalScript error.' || raw === undefined) {
    throw new Error(`${fn}: ExtendScript error (host.jsx failed to load or threw outside its guard)`)
  }
  let parsed: { ok: boolean; data?: T; error?: string; line?: number }
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`${fn}: unreadable reply: ${raw.slice(0, 200)}`)
  }
  if (!parsed.ok) throw new Error(`${parsed.error}${parsed.line ? ` (host.jsx line ${parsed.line})` : ''}`)
  return parsed.data as T
}

/** Load sentinel: if PM_ping is missing, host.jsx did not parse; try once to re-evaluate it. */
export async function connect(): Promise<{ app: string; version: string; sequence: string | null }> {
  if (!cs) throw new Error('Not running inside Premiere Pro.')
  const has = await evalRaw('typeof PM_ping')
  if (has !== 'function' && typeof SystemPath !== 'undefined') {
    const ext = cs.getSystemPath(SystemPath.EXTENSION).replace(/\\/g, '/')
    await evalRaw(`$.evalFile("${ext}/jsx/host.jsx")`)
  }
  return call('PM_ping')
}

export const projectInfo = () => call<{ name: string | null; path: string | null }>('PM_projectInfo')
/** The frame at the playhead; `raw`: the camera's clip alone, without ProMatch (PM_captureFrame). */
export const captureFrame = (path: string, raw = true) => call<CaptureInfo>('PM_captureFrame', { path, raw })
export const selection = () => call<SelectedClip[]>('PM_selection')
export const addLumetri = () => call<{ added: number; failed: string[] }>('PM_addLumetri')
export const dumpEffects = () => call<EffectDump>('PM_dumpEffects')
export const trySetLut = (params: string[], value: string | number) => call<LutSpike>('PM_trySetLut', { params, value })

export interface ApplyResult {
  /** The ProMatch effect is not installed (Premiere did not find it by name). */
  missingEffect: boolean
  /** Only for build-1 effects, which re-render through a Revision slider. */
  revision?: number | null
  clips: Array<{
    name: string
    track: number
    added: boolean
    previousId: number
    /** The LUT is stored in the effect (saved with the project), not only read from AppData. */
    embedded: boolean
    /** Why it was not embedded. */
    lutNote: string | null
    /** The clip's effects listed before ProMatch (display names). Not the real order: see app.ts apply. */
    before: string[]
    /** All the clip's effects but ProMatch, Opacity and Motion. */
    effects: string[]
  }>
  failed?: string[]
}

export interface SequenceColour extends ColourSetup {
  sequence: string
}

export const sequenceColour = () => call<SequenceColour>('PM_sequenceColour')

/** Reselect the selected clips so Effect Controls redraws (the effect's LUT name). */
export const refreshEffectControls = () => call<number>('PM_refreshEffectControls')

/** Open this panel, or bring it forward if it is open behind another. */
export function bringToFront(): void {
  try {
    ;(cs as unknown as { requestOpenExtension(id: string, params: string): void } | null)?.requestOpenExtension('com.promatch.panel.main', '')
  } catch {
    // Not in CEP: nothing to bring forward.
  }
  window.focus()
}

/** Open a web page in the user's browser (a new window outside CEP). */
export function openExternal(url: string): void {
  const open = (cs as unknown as { openURLInDefaultBrowser?(url: string): void } | null)?.openURLInDefaultBrowser
  if (open) open.call(cs, url)
  else window.open(url, '_blank')
}

/** Close this panel (the helper reopens it, see app.ts watchEditRequests). */
export function closeSelf(): void {
  ;(cs as unknown as { closeExtension(): void } | null)?.closeExtension()
}

/** `lut`: the effect's LUT text (toEmbeddedText in core/lut.ts, or the calibration pattern). */
export const applyMatch = (id: number, lut: string) => call<ApplyResult>('PM_applyMatch', { id, lut })
