import { describe, expect, it, vi } from 'vitest'

import { createKeepAwakeController, wantsKeepAwake } from '../src/bridge/platform'

describe('keep-awake modes', () => {
  it('holds only as the mode says', () => {
    expect(wantsKeepAwake('off', 3)).toBe(false)
    expect(wantsKeepAwake('always', 0)).toBe(true)
    expect(wantsKeepAwake('while-working', 0)).toBe(false)
    expect(wantsKeepAwake('while-working', 1)).toBe(true)
  })

  it('applies transitions only, following turns in flight', () => {
    const apply = vi.fn(async () => undefined)
    const controller = createKeepAwakeController(apply)

    controller.setMode('while-working')
    expect(apply).not.toHaveBeenCalled()

    controller.setActiveWork(1)
    controller.setActiveWork(2)
    expect(apply).toHaveBeenCalledTimes(1)
    expect(apply).toHaveBeenLastCalledWith(true)

    controller.setActiveWork(0)
    expect(apply).toHaveBeenLastCalledWith(false)

    controller.setMode('always')
    expect(apply).toHaveBeenLastCalledWith(true)

    controller.setMode('off')
    expect(apply).toHaveBeenLastCalledWith(false)
    expect(apply).toHaveBeenCalledTimes(4)
  })

  it('treats an unknown mode as off', () => {
    const apply = vi.fn(async () => undefined)
    const controller = createKeepAwakeController(apply)

    controller.setMode('always')
    controller.setMode('bogus' as never)
    expect(apply).toHaveBeenLastCalledWith(false)
  })
})
