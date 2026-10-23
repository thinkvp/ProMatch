/** The panel's log drawer. Also mirrors to the DevTools console (:8094). */
let el: HTMLElement | null = null
let toggle: HTMLElement | null = null

export function attachLog(target: HTMLElement, toggleButton?: HTMLElement): void {
  el = target
  toggle = toggleButton ?? null
}

export function log(msg: string, level: 'info' | 'warn' | 'error' = 'info'): void {
  const line = `${new Date().toLocaleTimeString()}  ${msg}`
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
  if (!el) return
  const row = document.createElement('div')
  row.className = `log-${level}`
  row.textContent = line
  el.appendChild(row)
  el.scrollTop = el.scrollHeight
  // A red dot on the collapsed drawer, so errors are not silently missed.
  if (level === 'error' && el.hidden) toggle?.classList.add('has-error')
}

export function clearErrorBadge(): void {
  toggle?.classList.remove('has-error')
}
