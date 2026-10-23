import { App } from './app.ts'
import { attachLog, log } from './log.ts'
import { syncWithHost } from './theme.ts'

window.addEventListener('DOMContentLoaded', () => {
  syncWithHost()
  attachLog(document.getElementById('log')!, document.getElementById('log-toggle')!)
  window.addEventListener('error', (e) => {
    // Chromium reports a harmless ResizeObserver re-entry as an error.
    if (/ResizeObserver loop/.test(e.message)) return
    log(`Uncaught: ${e.message}`, 'error')
  })
  window.addEventListener('unhandledrejection', (e) => log(`Unhandled: ${String(e.reason?.message ?? e.reason)}`, 'error'))
  const app = new App()
  // Handle for poking at state from DevTools (:8094).
  ;(window as unknown as { promatch: App }).promatch = app
  app.init().catch((e) => log(`Startup failed: ${e?.message ?? e}`, 'error'))
})
