/**
 * First-launch / re-auth connect screen.
 *
 * Plain DOM on purpose: it runs BEFORE the desktop renderer (and its React tree,
 * i18n and theme providers) is loaded, and again as an overlay whenever the
 * session is lost. Matches the Hermes dark look with a few CSS variables.
 */

import appIconUrl from './assets/app-icon.png'
import { type AuthSession, InvalidCredentialsError } from './bridge/auth'
import { errorMessage, LanCleartextConsentRequired, normalizeBaseUrl } from './bridge/util'

export interface LoginRequest {
  baseUrl?: string
  reason?: string
}

export interface ConnectUi {
  bind(auth: AuthSession): void
  prompt(request?: LoginRequest): Promise<boolean>
}

const STYLE = `
.hm-connect{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;
  padding:max(16px,env(safe-area-inset-top)) max(16px,env(safe-area-inset-right)) max(16px,env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left));
  background:#0a0a0a;color:#ececec;font:15px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;overflow:auto}
.hm-connect *{box-sizing:border-box}
.hm-card{width:100%;max-width:420px;background:#141414;border:1px solid #262626;border-radius:14px;padding:22px 20px}
.hm-brand{display:flex;align-items:center;gap:10px;margin-bottom:4px}
.hm-brand img{width:30px;height:30px;border-radius:7px}
.hm-brand h1{margin:0;font-size:20px;font-weight:600;letter-spacing:.2px}
.hm-sub{margin:0 0 18px;color:#9a9a9a;font-size:13px}
.hm-reason{margin:0 0 14px;padding:9px 11px;border-radius:8px;background:#2a2110;border:1px solid #5b4720;color:#e9cf8f;font-size:13px}
.hm-field{display:block;margin-bottom:13px}
.hm-field span{display:block;margin-bottom:5px;color:#b5b5b5;font-size:12px;text-transform:uppercase;letter-spacing:.6px}
.hm-field input{width:100%;height:46px;padding:0 12px;border-radius:9px;border:1px solid #333;background:#0d0d0d;color:#f2f2f2;font-size:16px;outline:none}
.hm-field input:focus{border-color:#8b8b8b}
.hm-consent{margin:0 0 14px}
.hm-consent .hm-reason{margin-bottom:8px}
.hm-consent .hm-reason p{margin:0}
.hm-consent .hm-reason p + p{margin-top:6px}
.hm-check{display:flex;align-items:flex-start;gap:10px;color:#d6d6d6;font-size:14px}
.hm-check input{flex:none;width:20px;height:20px;margin:1px 0 0;accent-color:#e9cf8f}
.hm-hint{margin:-6px 0 13px;color:#7d7d7d;font-size:12px}
.hm-error{min-height:18px;margin:2px 0 10px;color:#ff8f8f;font-size:13px;white-space:pre-wrap;word-break:break-word}
.hm-status{min-height:18px;margin:2px 0 10px;color:#9dc3ff;font-size:13px}
.hm-btn{width:100%;height:48px;border:0;border-radius:10px;background:#f2f2f2;color:#0a0a0a;font-size:16px;font-weight:600}
.hm-btn[disabled]{opacity:.55}
.hm-link{display:block;margin:14px auto 0;background:none;border:0;color:#8f8f8f;font-size:13px;text-decoration:underline}
`

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {},
  children: (Node | string)[] = []
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props)
  node.append(...children)

  return node
}

export function createConnectUi(): ConnectUi {
  let auth: AuthSession | null = null
  let active: Promise<boolean> | null = null

  const show = (request: LoginRequest): Promise<boolean> =>
    new Promise(resolve => {
      if (!auth) {
        throw new Error('Connect screen used before the bridge was bound')
      }

      const session = auth
      const dismissible = Boolean(request.reason) || document.getElementById('root')?.childElementCount

      const style = el('style', { textContent: STYLE })
      const root = el('div', { className: 'hm-connect' })

      const urlInput = el('input', {
        autocapitalize: 'none',
        autocomplete: 'off',
        inputMode: 'url',
        name: 'server',
        placeholder: '100.x.y.z:9119 or my-pc.tailnet.ts.net:9119',
        spellcheck: false,
        type: 'text'
      })

      const userInput = el('input', { autocapitalize: 'none', autocomplete: 'username', name: 'username', spellcheck: false, type: 'text' })
      const passInput = el('input', { autocomplete: 'current-password', name: 'password', type: 'password' })
      const status = el('div', { className: 'hm-status' })
      const error = el('div', { className: 'hm-error', role: 'alert' })
      const button = el('button', { className: 'hm-btn', textContent: 'Connect', type: 'submit' })

      // Shown only after the gateway answered with LanCleartextConsentRequired for a LAN http:// address.
      const consent = el('input', { id: 'hm-lan-consent', name: 'lan-consent', type: 'checkbox' })

      const consentBlock = el('div', { className: 'hm-consent', hidden: true }, [
        el('div', { className: 'hm-reason' }, [
          el('p', {
            textContent:
              'This address is on your local network, not Tailscale. Over http:// your password and session token travel unencrypted and anyone on this Wi-Fi can read them.'
          }),
          el('p', { textContent: "Use your PC's Tailscale address (100.x.y.z) instead." })
        ]),
        el('label', { className: 'hm-check' }, [consent, el('span', { textContent: 'I understand, connect anyway over this network' })])
      ])

      let consentRequired = false
      let acceptedLanUrl: string | undefined

      const icon = el('img', { alt: '', src: appIconUrl })

      const card = el('form', { className: 'hm-card' }, [
        el('div', { className: 'hm-brand' }, [icon, el('h1', { textContent: 'Mono Hermes' })]),
        el('p', { className: 'hm-sub', textContent: 'Unofficial community client. Connect to the Hermes server running on your PC.' }),
        ...(request.reason ? [el('p', { className: 'hm-reason', textContent: request.reason })] : []),
        el('label', { className: 'hm-field' }, [el('span', { textContent: 'Server' }), urlInput]),
        el('p', { className: 'hm-hint', textContent: 'Tailscale IP (100.x.y.z) or MagicDNS name of the PC, with the port.' }),
        el('label', { className: 'hm-field' }, [el('span', { textContent: 'Username' }), userInput]),
        el('label', { className: 'hm-field' }, [el('span', { textContent: 'Password' }), passInput]),
        consentBlock,
        status,
        error,
        button
      ])

      if (dismissible) {
        const cancel = el('button', { className: 'hm-link', textContent: 'Not now', type: 'button' })
        cancel.addEventListener('click', () => finish(false))
        card.append(cancel)
      }

      root.append(card)
      document.head.append(style)
      document.body.append(root)

      void session.store.getConnection().then(stored => {
        urlInput.value = request.baseUrl || stored?.baseUrl || ''
        userInput.value = stored?.username ?? ''
        acceptedLanUrl = stored?.lanCleartextAcceptedFor
        ;(urlInput.value ? (userInput.value ? passInput : userInput) : urlInput).focus()
      })

      function finish(ok: boolean) {
        root.remove()
        style.remove()
        resolve(ok)
      }

      // A new address needs a fresh decision: forget any warning shown for the previous one.
      urlInput.addEventListener('input', () => {
        consentRequired = false
        consentBlock.hidden = true
        consent.checked = false
        button.disabled = false
      })

      consent.addEventListener('change', () => {
        button.disabled = !consent.checked
      })

      // Consent is per server: accepted now (checkbox) or at an earlier login for this exact URL.
      const lanCleartextAccepted = (): boolean => {
        if (consent.checked) {
          return true
        }

        try {
          return Boolean(acceptedLanUrl) && normalizeBaseUrl(urlInput.value) === acceptedLanUrl
        } catch {
          return false
        }
      }

      card.addEventListener('submit', async event => {
        event.preventDefault()

        if (consentRequired && !consent.checked) {
          return
        }

        error.textContent = ''
        button.disabled = true
        status.textContent = 'Contacting the server...'

        try {
          await session.login(
            urlInput.value,
            { password: passInput.value, username: userInput.value.trim() },
            { allowLanCleartext: lanCleartextAccepted() }
          )
          finish(true)
        } catch (failure) {
          status.textContent = ''

          if (failure instanceof LanCleartextConsentRequired) {
            consentRequired = true
            consentBlock.hidden = false
            button.disabled = !consent.checked
            consent.focus()

            return
          }

          error.textContent = failure instanceof InvalidCredentialsError ? failure.message : errorMessage(failure)
          button.disabled = consentRequired && !consent.checked
          passInput.select()
        }
      })
    })

  return {
    bind(next) {
      auth = next
    },
    prompt(request = {}) {
      active ??= show(request).finally(() => {
        active = null
      })

      return active
    }
  }
}
