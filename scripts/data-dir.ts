/**
 * ProMatch's data folder, where the panel keeps the session, captures and
 * saved test cases: %APPDATA%\ProMatch on Windows,
 * ~/Library/Application Support/ProMatch on macOS (as src/panel/node.ts).
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

export const dataDir =
  process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Application Support', 'ProMatch')
    : join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'ProMatch')
