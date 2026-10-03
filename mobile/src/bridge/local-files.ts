/**
 * Phone-side file registry.
 *
 * The desktop renderer thinks in absolute filesystem paths (picker results, drop
 * targets, pasted images) and reads them back through `readFileDataUrl` /
 * `readFileText`. A WebView has no such paths - it has `File` objects from
 * `<input type="file">` - so every File the user hands us is registered under a
 * synthetic `mobile-file://<id>/<name>` path and served back from memory. The
 * renderer keeps working unchanged; the gateway receives the bytes as a data URL
 * exactly like a desktop attach.
 */

import type { HermesReadFileTextResult, HermesSelectPathsOptions } from '@/global'

export const MOBILE_FILE_PREFIX = 'mobile-file://'

const MAX_REMEMBERED = 64
const registry = new Map<string, File>()

function nextId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
}

export function registerFile(blob: Blob, name: string): string {
  const safeName = name.replace(/[\\/:*?"<>|]+/g, '_') || 'file'
  const file = blob instanceof File ? blob : new File([blob], safeName, { type: blob.type })
  const id = nextId()

  registry.set(id, file)

  while (registry.size > MAX_REMEMBERED) {
    const oldest = registry.keys().next().value

    if (oldest === undefined) {
      break
    }

    registry.delete(oldest)
  }

  return `${MOBILE_FILE_PREFIX}${id}/${encodeURIComponent(safeName)}`
}

export function isMobileFilePath(path: string): boolean {
  return path.startsWith(MOBILE_FILE_PREFIX)
}

export function resolveFile(path: string): File {
  const id = path.slice(MOBILE_FILE_PREFIX.length).split('/', 1)[0]
  const file = registry.get(id)

  if (!file) {
    throw new Error('That file is no longer available on this phone. Attach it again.')
  }

  return file
}

export function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('Could not read file'))
    reader.readAsDataURL(blob)
  })
}

export async function readDataUrl(path: string, maxBytes?: number): Promise<string> {
  if (!isMobileFilePath(path)) {
    throw new Error('Only files chosen on this phone can be read here.')
  }

  const file = resolveFile(path)

  if (maxBytes && file.size > maxBytes) {
    throw new Error(`File is too large (${Math.round(file.size / 1024 / 1024)} MB).`)
  }

  return readAsDataUrl(file)
}

const TEXT_PREVIEW_MAX_BYTES = 512 * 1024

export async function readText(path: string): Promise<HermesReadFileTextResult> {
  const file = resolveFile(path)
  const slice = file.slice(0, TEXT_PREVIEW_MAX_BYTES)

  return {
    byteSize: file.size,
    mimeType: file.type || undefined,
    path,
    text: await slice.text(),
    truncated: file.size > TEXT_PREVIEW_MAX_BYTES
  }
}

function acceptFromFilters(options: HermesSelectPathsOptions): string {
  const exts = (options.filters ?? []).flatMap(filter => filter.extensions ?? []).filter(ext => ext && ext !== '*')

  return exts.map(ext => `.${ext.replace(/^\./, '')}`).join(',')
}

/** Open the system picker. Directories cannot be picked on a phone and resolve to a cancel. */
export function pickFiles(options: HermesSelectPathsOptions = {}): Promise<string[]> {
  if (options.directories) {
    return Promise.resolve([])
  }

  return new Promise(resolve => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = options.multiple === true
    input.style.display = 'none'

    const accept = acceptFromFilters(options)

    if (accept) {
      input.accept = accept
    }

    let settled = false

    const finish = (paths: string[]) => {
      if (!settled) {
        settled = true
        input.remove()
        resolve(paths)
      }
    }

    input.addEventListener('change', () => finish(Array.from(input.files ?? []).map(file => registerFile(file, file.name))))
    input.addEventListener('cancel', () => finish([]))
    document.body.appendChild(input)
    input.click()
  })
}
