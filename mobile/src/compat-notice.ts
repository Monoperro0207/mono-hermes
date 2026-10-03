/**
 * Discreet "server version differs" notice, shown over the app shell.
 *
 * Plain DOM like connect-screen.ts: it lives outside the (unmodified) upstream renderer.
 * After the app is connected it asks the public /api/status for the server version and,
 * when it is far from the version this build was tested with, shows one dismissible note.
 */

import { probeServer } from './bridge/auth'
import type { ConnectionStore } from './bridge/connection'
import type { HttpTransport } from './bridge/http'
import { buildInfo } from './build-info'
import { pendingNotice, rememberDismissal } from './compat'

const STYLE = `
.hm-compat{position:fixed;left:0;right:0;top:0;z-index:2147482000;display:flex;justify-content:center;pointer-events:none;
  padding:max(8px,env(safe-area-inset-top)) max(8px,env(safe-area-inset-right)) 0 max(8px,env(safe-area-inset-left))}
.hm-compat-card{pointer-events:auto;display:flex;align-items:center;gap:4px;max-width:460px;width:100%;
  background:#1d1a12;border:1px solid #5b4720;border-radius:10px;color:#e9cf8f;box-shadow:0 6px 20px rgba(0,0,0,.45);
  font:12px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.hm-compat-text{flex:1;padding:8px 0 8px 12px}
.hm-compat-close{flex:none;width:44px;height:44px;border:0;background:transparent;color:#e9cf8f;font-size:20px;line-height:1}
`

function show(message: string, onDismiss: () => void): () => void {
  const style = document.createElement('style')
  style.textContent = STYLE

  const root = document.createElement('div')
  root.className = 'hm-compat'
  root.setAttribute('role', 'status')

  const card = document.createElement('div')
  card.className = 'hm-compat-card'

  const text = document.createElement('div')
  text.className = 'hm-compat-text'
  text.textContent = message

  const close = document.createElement('button')
  close.className = 'hm-compat-close'
  close.type = 'button'
  close.setAttribute('aria-label', 'Dismiss')
  close.textContent = '×'

  const remove = () => {
    root.remove()
    style.remove()
  }

  close.addEventListener('click', () => {
    onDismiss()
    remove()
  })

  card.append(text, close)
  root.append(card)
  document.head.append(style)
  document.body.append(root)

  return remove
}

/**
 * Checks once now and again whenever the saved server changes. Never throws and never
 * blocks startup: a failing probe just means no notice.
 */
export function installCompatNotice(store: ConnectionStore, transport: HttpTransport): void {
  let checkedBaseUrl: string | null = null
  let removeCurrent: (() => void) | null = null

  const check = async () => {
    const connection = await store.getConnection()

    if (!connection?.baseUrl || connection.baseUrl === checkedBaseUrl) {
      return
    }

    checkedBaseUrl = connection.baseUrl
    removeCurrent?.()
    removeCurrent = null

    try {
      const probe = await probeServer(transport, connection.baseUrl)
      const notice = pendingNotice(window.localStorage, probe.version, buildInfo.pinnedBackendVersion)

      if (notice) {
        removeCurrent = show(notice.message, () =>
          rememberDismissal(window.localStorage, notice.serverVersion, buildInfo.pinnedBackendVersion)
        )
      }
    } catch {
      checkedBaseUrl = null // retry on the next connection change
    }
  }

  void check().catch(() => undefined)
  store.onChange(() => void check().catch(() => undefined))
}
