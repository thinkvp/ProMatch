/*
 * Evaluate JavaScript inside the running ProMatch panel over its DevTools
 * port (.debug: 8094) — lets spikes run without touching Premiere's UI.
 *   node scripts/cdp.mjs "<expression>"     (awaited; result printed as JSON)
 *   node scripts/cdp.mjs -f expr.js          (expression read from a file — no shell quoting)
 */
import { readFileSync } from 'node:fs'

const expr = process.argv[2] === '-f' ? readFileSync(process.argv[3], 'utf8') : process.argv[2]
if (!expr) {
  console.error('usage: node scripts/cdp.mjs "<expression>"')
  process.exit(2)
}
const pages = await (await fetch('http://localhost:8094/json/list')).json()
const page = pages.find((p) => p.title === 'ProMatch') ?? pages[0]
if (!page) throw new Error('ProMatch panel is not open (no page on :8094)')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r, j) => {
  ws.onopen = r
  ws.onerror = j
})
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data)
  if (msg.id !== 1) return
  const r = msg.result
  if (r?.exceptionDetails) console.log('EXCEPTION', JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails))
  else console.log(typeof r?.result?.value === 'string' ? r.result.value : JSON.stringify(r?.result?.value ?? r, null, 1))
  ws.close()
}
ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: `(async () => (${expr}))()`, awaitPromise: true, returnByValue: true } }))
