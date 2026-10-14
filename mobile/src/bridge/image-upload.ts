/**
 * Shrinks picked photos before the composer uploads them.
 *
 * In remote mode the renderer reads an image through `readFileDataUrl` and sends the whole file,
 * base64-encoded, in one `image.attach_bytes` call that must finish within the gateway client's
 * 30 s request timeout. A modern phone photo is 5-25 MB: over Tailscale on mobile data that misses
 * the timeout, and above the 16 MB read cap it is refused outright ("too large to upload to the
 * remote gateway"). Vision models downscale to roughly 1.5-2K pixels anyway, so the phone sends at
 * most {@link UPLOAD_IMAGE_MAX_EDGE} px on the long edge: a 20 MB photo becomes about 1 MB.
 * Re-encoding also drops EXIF metadata, GPS location included (orientation is applied first).
 *
 * Images that are already small, formats that cannot be re-encoded in the same format here (GIF,
 * SVG, HEIC, BMP) and anything that fails to decode are sent unchanged. Attaching a photo as a *file* instead of an
 * image keeps the original bytes.
 */

/** Longest edge, in pixels, of an uploaded photo. */
export const UPLOAD_IMAGE_MAX_EDGE = 2560
/** Images at or under this size and edge are sent as they are. */
export const UPLOAD_IMAGE_KEEP_BYTES = 1536 * 1024
/** Largest source the phone tries to decode (a decoded 200 MP photo alone is ~800 MB of pixels). */
export const UPLOAD_IMAGE_SOURCE_MAX_BYTES = 64 * 1024 * 1024
const ENCODE_QUALITY = 0.85

export type UploadImageType = 'image/jpeg' | 'image/png' | 'image/webp'

const EXTENSION_TYPES: Record<string, UploadImageType> = { jpeg: 'image/jpeg', jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }

/**
 * The format a photo is re-encoded in, or null when it is sent as is. It always matches the source:
 * the gateway names the stored file after the picked one and trusts that extension, so a JPEG body
 * under a `.webp` name would reach the model with the wrong type. HEIC/BMP cannot be encoded here.
 */
export function uploadTypeFor(sourceType: string, name: string): UploadImageType | null {
  const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase()
  const byName = extension ? EXTENSION_TYPES[extension] : undefined
  const byType = Object.values(EXTENSION_TYPES).find(candidate => candidate === sourceType.toLowerCase())

  // An extension we cannot write (".heic"), or a name and type that disagree: leave it alone.
  if ((extension && !byName) || (byName && byType && byName !== byType)) {
    return null
  }

  return byName ?? byType ?? null
}

export interface ImageResizePlan {
  height: number
  width: number
}

/** Target size for an image, or null when it should be sent unchanged. */
export function planImageUpload(width: number, height: number, bytes: number): ImageResizePlan | null {
  const edge = Math.max(width, height)

  if (!(edge > 0)) {
    return null
  }

  const scale = Math.min(1, UPLOAD_IMAGE_MAX_EDGE / edge)

  if (scale === 1 && bytes <= UPLOAD_IMAGE_KEEP_BYTES) {
    return null
  }

  return { height: Math.max(1, Math.round(height * scale)), width: Math.max(1, Math.round(width * scale)) }
}

function encode(canvas: HTMLCanvasElement, type: string): Promise<Blob | null> {
  return new Promise(resolve => canvas.toBlob(resolve, type, ENCODE_QUALITY))
}

async function shrink(file: File): Promise<Blob> {
  const type = uploadTypeFor(file.type, file.name)

  if (!type || file.size > UPLOAD_IMAGE_SOURCE_MAX_BYTES) {
    return file
  }

  let bitmap: ImageBitmap

  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    return file
  }

  try {
    const plan = planImageUpload(bitmap.width, bitmap.height, file.size)

    if (!plan) {
      return file
    }

    const canvas = document.createElement('canvas')
    canvas.width = plan.width
    canvas.height = plan.height

    const context = canvas.getContext('2d')

    if (!context) {
      return file
    }

    context.imageSmoothingQuality = 'high'
    context.drawImage(bitmap, 0, 0, plan.width, plan.height)

    const blob = await encode(canvas, type)

    // Keep the original when re-encoding did not help (e.g. an already tight PNG within the edge).
    return blob && blob.size < file.size ? blob : file
  } catch {
    return file
  } finally {
    bitmap.close()
  }
}

// The renderer reads the same picked image twice (thumbnail, then upload): decode it once.
const prepared = new WeakMap<File, Promise<Blob>>()

export function prepareImageForUpload(file: File): Promise<Blob> {
  let pending = prepared.get(file)

  if (!pending) {
    pending = shrink(file)
    prepared.set(file, pending)
  }

  return pending
}
