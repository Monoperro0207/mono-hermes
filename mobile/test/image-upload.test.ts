import { describe, expect, it, vi } from 'vitest'

import { createWorkReporter } from '../src/bridge/background-connection'
import {
  planImageUpload,
  UPLOAD_IMAGE_KEEP_BYTES,
  UPLOAD_IMAGE_MAX_EDGE,
  uploadTypeFor
} from '../src/bridge/image-upload'

const MB = 1024 * 1024

describe('photo upload plan', () => {
  it('shrinks a camera photo to the max edge, keeping the aspect ratio', () => {
    expect(planImageUpload(8160, 6120, 20 * MB)).toEqual({ height: 1920, width: UPLOAD_IMAGE_MAX_EDGE })
    expect(planImageUpload(3000, 4000, 6 * MB)).toEqual({ height: UPLOAD_IMAGE_MAX_EDGE, width: 1920 })
  })

  it('sends small images untouched', () => {
    expect(planImageUpload(1080, 2400, 900 * 1024)).toBeNull()
    expect(planImageUpload(UPLOAD_IMAGE_MAX_EDGE, 1000, UPLOAD_IMAGE_KEEP_BYTES)).toBeNull()
  })

  it('re-encodes a heavy image even when it is within the edge', () => {
    expect(planImageUpload(2000, 1500, 9 * MB)).toEqual({ height: 1500, width: 2000 })
  })

  it('ignores images without dimensions', () => {
    expect(planImageUpload(0, 0, 9 * MB)).toBeNull()
  })
})

describe('photo upload format', () => {
  it('keeps the source format, which the gateway reads from the file name', () => {
    expect(uploadTypeFor('image/jpeg', 'IMG_1.jpg')).toBe('image/jpeg')
    expect(uploadTypeFor('image/jpeg', 'IMG_1.JPEG')).toBe('image/jpeg')
    expect(uploadTypeFor('image/png', 'Screenshot.png')).toBe('image/png')
    expect(uploadTypeFor('image/webp', 'pic.webp')).toBe('image/webp')
    expect(uploadTypeFor('', 'pic.png')).toBe('image/png')
    expect(uploadTypeFor('image/jpeg', '1000012345')).toBe('image/jpeg')
  })

  it('leaves formats it cannot write, and contradictions, alone', () => {
    expect(uploadTypeFor('image/heic', 'IMG_1.heic')).toBeNull()
    expect(uploadTypeFor('image/jpeg', 'IMG_1.heic')).toBeNull()
    expect(uploadTypeFor('image/gif', 'anim.gif')).toBeNull()
    expect(uploadTypeFor('image/png', 'mislabeled.jpg')).toBeNull()
    expect(uploadTypeFor('', 'notes')).toBeNull()
  })
})

describe('background connection work reports', () => {
  it('reports only the transitions between working and idle', () => {
    const report = vi.fn(async () => undefined)
    const onWork = createWorkReporter(report)

    onWork(0)
    onWork(1)
    onWork(3)
    onWork(0)
    onWork(0)

    expect(report.mock.calls).toEqual([[false], [true], [false]])
  })
})
