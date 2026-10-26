import { describe, expect, it } from 'vitest'
import { copyFor, DISPLAY_STATE_COPY, isDisplayState } from '../src/presentation/display-state'
import { DISPLAY_STATES } from '../src/data/contracts/types'

describe('展示状态词典', () => {
  it('10 种状态都有文案，且主文案互不重复', () => {
    expect(DISPLAY_STATES).toHaveLength(10)
    const labels = new Set<string>()
    for (const state of DISPLAY_STATES) {
      const copy = DISPLAY_STATE_COPY[state]
      expect(copy.label.length).toBeGreaterThan(0)
      expect(copy.explanation.length).toBeGreaterThan(0)
      expect(copy.nextStep.length).toBeGreaterThan(0)
      expect(copy.icon.length).toBeGreaterThan(0)
      labels.add(copy.label)
    }
    expect(labels.size).toBe(10)
  })

  it('未知枚举降级为"未知状态，需核查"，不映射成已验收', () => {
    expect(isDisplayState('verification_pending')).toBe(false)
    const copy = copyFor('verification_pending')
    expect(copy.label).toBe('未知状态，需核查')
    expect(copy.tone).toBe('muted')
  })

  it('等待停止不会提示重新派工', () => {
    expect(DISPLAY_STATE_COPY.waiting_stop.nextStep).toContain('不要重新派工')
  })

  it('已取消明确终态，不提供继续执行路径', () => {
    expect(DISPLAY_STATE_COPY.cancelled.explanation).toContain('不能当作暂停')
  })
})
