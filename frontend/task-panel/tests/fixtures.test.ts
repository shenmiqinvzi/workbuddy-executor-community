import { describe, expect, it } from 'vitest'
import { SCENARIOS, scenarioById } from '../src/data/mock/scenarios'
import { DISPLAY_STATES, type TaskView } from '../src/data/contracts/types'

const allTasks = (): Array<{ scenario: string; frame: number; task: TaskView }> =>
  SCENARIOS.flatMap((scenario) =>
    scenario.frames.flatMap((frame, frameIndex) =>
      frame.tasks.map((task) => ({ scenario: scenario.id, frame: frameIndex, task })),
    ),
  )

describe('合成场景与 fixture', () => {
  it('共 16 个场景，编号 M01–M16 且唯一', () => {
    expect(SCENARIOS).toHaveLength(16)
    expect(SCENARIOS.map((item) => item.id)).toEqual(
      Array.from({ length: 16 }, (_, index) => `M${String(index + 1).padStart(2, '0')}`),
    )
    expect(new Set(SCENARIOS.map((item) => item.id)).size).toBe(16)
  })

  it('每个场景都至少有 1 帧，且共用同一个演示起点', () => {
    for (const scenario of SCENARIOS) {
      expect(scenario.frames.length).toBeGreaterThan(0)
      expect(scenario.fixtureNow).toBe('2026-10-20T01:10:00Z')
    }
  })

  it('M01–M09 合起来覆盖全部 10 种展示状态', () => {
    const covered = new Set(
      SCENARIOS.filter((scenario) => Number(scenario.id.slice(1)) <= 9).flatMap((scenario) =>
        scenario.frames.flatMap((frame) => frame.tasks.map((task) => task.displayState)),
      ),
    )
    for (const state of DISPLAY_STATES) {
      expect(covered.has(state), `缺少状态 ${state}`).toBe(true)
    }
  })

  it('所有任务使用合成标识，且不含写操作', () => {
    for (const { task } of allTasks()) {
      expect(task.taskId.startsWith('example-')).toBe(true)
      expect(task.workspace.id.startsWith('example-')).toBe(true)
      expect(task.attempt.number).toBeLessThanOrEqual(task.attempt.limit)
      for (const action of task.allowedActions) {
        expect(['export', 'cancel', 'review', 'accept', 'rework']).toContain(action)
      }
      for (const change of task.changes) {
        expect(change.path.startsWith('/')).toBe(false)
        expect(change.path.includes(':\\')).toBe(false)
      }
      for (const path of task.artifacts.map((artifact) => artifact.relativePath)) {
        expect(path.startsWith('/')).toBe(false)
      }
    }
  })

  it('除 M15 故意构造的坏数据外，时间字段都是合法 ISO', () => {
    for (const { scenario, task } of allTasks()) {
      if (scenario === 'M15') continue
      for (const value of Object.values(task.timing)) {
        if (value === null) continue
        expect(Number.isNaN(Date.parse(value)), `${task.taskId} 时间非法：${String(value)}`).toBe(false)
      }
    }
  })

  it('M02 的等待停止帧报告已到但没有停止证据', () => {
    const frame = scenarioById('M02')?.frames[1]
    expect(frame).toBeDefined()
    const task = frame?.tasks[0]
    expect(task?.displayState).toBe('waiting_stop')
    expect(task?.remoteStopped).toBe(false)
    expect(frame?.events.some((event) => event.type === 'report_received')).toBe(true)
    expect(frame?.events.some((event) => event.type === 'native_stop_confirmed')).toBe(false)
  })

  it('M12 的未知成本保持 null，不用 0 补齐', () => {
    const task = scenarioById('M12')?.frames[0]?.tasks[0]
    expect(task?.metrics?.usage.actualCredits).toBeNull()
    expect(task?.metrics?.usage.tokens).toBeNull()
    expect(task?.artifacts[0]?.bytes).toBeNull()
    expect(task?.checks.some((check) => check.status === 'checker_error')).toBe(true)
  })

  it('M15 同时包含未知枚举、非法时间与矛盾证据', () => {
    const tasks = scenarioById('M15')?.frames[0]?.tasks ?? []
    const weird = tasks.find((task) => task.taskId === 'example-task-015')
    const conflict = tasks.find((task) => task.taskId === 'example-task-016')
    expect(weird?.displayState as string).toBe('verification_pending')
    expect(weird?.timing.lastObservedAt).toBe('not-a-date')
    expect(conflict?.displayState).toBe('needs_review')
    expect(conflict?.remoteStopped).toBe(false)
  })

  it('M14 前两帧是加载中与空列表，第三帧才有任务', () => {
    const frames = scenarioById('M14')?.frames ?? []
    expect(frames[0]?.health.status).toBe('loading')
    expect(frames[0]?.tasks).toHaveLength(0)
    expect(frames[1]?.tasks).toHaveLength(0)
    expect(frames[2]?.tasks).toHaveLength(1)
  })

  it('M10 断线前后保持同一任务身份与期限', () => {
    const frames = scenarioById('M10')?.frames ?? []
    expect(frames.length).toBe(3)
    const first = frames[0]?.tasks[0]
    expect(first).toBeDefined()
    for (const frame of frames.slice(1)) {
      const next = frame.tasks[0]
      expect(next?.taskId).toBe(first?.taskId)
      expect(next?.attempt.id).toBe(first?.attempt.id)
      expect(next?.timing.attemptDeadlineAt).toBe(first?.timing.attemptDeadlineAt)
    }
  })

  it('M11 为第 3 / 3 轮且保留两次返工事件', () => {
    const frame = scenarioById('M11')?.frames[0]
    expect(frame?.tasks[0]?.attempt).toMatchObject({ number: 3, limit: 3 })
    const reworks = frame?.events.filter((event) => event.type === 'rework_requested') ?? []
    expect(reworks).toHaveLength(2)
  })
})
