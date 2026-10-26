import { describe, expect, it } from 'vitest'
import { DemoController } from '../src/demo/demo-controller'
import { SCENARIOS } from '../src/data/mock/scenarios'

const FIXTURE_NOW = Date.parse('2026-10-20T01:10:00Z')

describe('演示控制器', () => {
  it('时钟推进到下一帧偏移时切换帧，并可一次跨越多帧', () => {
    const controller = new DemoController(SCENARIOS, 'M01')
    expect(controller.getState().frameIndex).toBe(0)

    controller.advance(60_000)
    expect(controller.getState().frameIndex).toBe(1)
    expect(controller.getState().clockMs).toBe(FIXTURE_NOW + 60_000)

    controller.advance(10 * 60_000)
    expect(controller.getState().frameIndex).toBe(controller.getState().frameCount - 1)
  })

  it('重置只回到第 1 帧与演示起点，不改变任务事实', () => {
    const controller = new DemoController(SCENARIOS, 'M01')
    controller.advance(6 * 60_000)
    expect(controller.getState().frameIndex).toBe(2)

    const before = controller.currentFrame.tasks[0]
    controller.reset()
    const after = controller.currentFrame.tasks[0]

    expect(controller.getState().frameIndex).toBe(0)
    expect(controller.getState().clockMs).toBe(FIXTURE_NOW)
    expect(after?.timing.attemptDeadlineAt).toBe(before?.timing.attemptDeadlineAt)
    expect(after?.taskId).toBe(before?.taskId)
  })

  it('刷新模拟快照不换场景、不推进轮次，只增加刷新计数', () => {
    const controller = new DemoController(SCENARIOS, 'M02')
    const before = controller.currentFrame.tasks[0]
    controller.refresh()
    const after = controller.currentFrame.tasks[0]

    expect(controller.getState().refreshCount).toBe(1)
    expect(controller.getState().frameIndex).toBe(0)
    expect(after?.taskId).toBe(before?.taskId)
    expect(after?.attempt.id).toBe(before?.attempt.id)
  })

  it('切换帧把演示时钟设到该帧偏移（M07 到期场景）', () => {
    const controller = new DemoController(SCENARIOS, 'M07')
    controller.selectFrame(0)
    expect(controller.getState().clockMs).toBe(FIXTURE_NOW + 5 * 60_000)
    const task = controller.currentFrame.tasks[0]
    expect(task?.timing.attemptDeadlineAt).toBe(new Date(FIXTURE_NOW).toISOString())
  })

  it('未播放时后台恢复不会推进时钟', () => {
    const controller = new DemoController(SCENARIOS, 'M01')
    controller.resumeVisible()
    expect(controller.getState().clockMs).toBe(FIXTURE_NOW)
  })
})
