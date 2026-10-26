import { describe, expect, it } from 'vitest'
import { MockPanelDataSource, type FrameSnapshot } from '../src/data/mock/mock-panel-data-source'
import { scenarioById } from '../src/data/mock/scenarios'
import { PanelError, type TaskEvent } from '../src/data/contracts/types'

function snapshotFor(scenarioId: string, frameIndex = 0): FrameSnapshot {
  const scenario = scenarioById(scenarioId)
  if (!scenario) throw new Error(`未知场景 ${scenarioId}`)
  const frame = scenario.frames[frameIndex]
  if (!frame) throw new Error(`场景 ${scenarioId} 缺少第 ${frameIndex} 帧`)
  return {
    tasks: frame.tasks,
    events: frame.events,
    health: frame.health,
    asOf: frame.health.asOf,
    supplements: frame.supplements,
  }
}

const sourceFor = (scenarioId: string, frameIndex = 0) => new MockPanelDataSource(() => snapshotFor(scenarioId, frameIndex))

describe('只读数据源', () => {
  it('公开接口只有四个读取方法，没有任何写操作', () => {
    const proto = MockPanelDataSource.prototype as unknown as Record<string, unknown>
    for (const name of ['getHealth', 'getTask', 'listEvents', 'listTasks']) {
      expect(typeof proto[name]).toBe('function')
    }
    const publicMethods = Object.getOwnPropertyNames(proto)
      .filter((name) => name !== 'constructor')
      .filter((name) => typeof proto[name] === 'function')
      .filter((name) => !name.startsWith('settle'))
    expect(publicMethods.sort()).toEqual(['getHealth', 'getTask', 'listEvents', 'listTasks'])
    for (const forbidden of ['submit', 'rework', 'cancel', 'accept', 'respond', 'write']) {
      expect(proto[forbidden]).toBeUndefined()
    }
  })

  it('搜索只匹配标题，状态与项目分别筛选', async () => {
    const source = sourceFor('M01')
    const byTitle = await source.listTasks({ search: '计数' })
    expect(byTitle.tasks.map((task) => task.taskId)).toEqual(['example-task-001'])

    const byState = await source.listTasks({ displayState: 'accepted' })
    expect(byState.tasks.map((task) => task.taskId)).toEqual(['example-task-history'])

    const byProject = await source.listTasks({ projectId: 'example-project' })
    expect(byProject.tasks).toHaveLength(2)

    const none = await source.listTasks({ projectId: 'example-missing' })
    expect(none.tasks).toHaveLength(0)
  })

  it('按 createdAt 倒序、taskId 兜底排序', async () => {
    const source = sourceFor('M01')
    const page = await source.listTasks({})
    expect(page.tasks.map((task) => task.taskId)).toEqual(['example-task-001', 'example-task-history'])
  })

  it('读取不存在的任务明确失败', async () => {
    const source = sourceFor('M01')
    await expect(source.getTask('example-missing')).rejects.toBeInstanceOf(PanelError)
    await expect(source.getTask('example-missing')).rejects.toMatchObject({ code: 'PANEL_TASK_NOT_FOUND' })
  })

  it('事件按 eventId 去重、升序，并支持游标', async () => {
    const base = snapshotFor('M02', 2)
    const duplicate: TaskEvent = { ...base.events[0]! }
    const snapshot: FrameSnapshot = { ...base, events: [...base.events, duplicate] }
    const source = new MockPanelDataSource(() => snapshot)

    const all = await source.listEvents('example-task-002', 0)
    expect(all.events.map((event) => event.eventId)).toEqual(
      Array.from(new Set(all.events.map((event) => event.eventId))).sort((a, b) => a - b),
    )
    expect(all.events).toHaveLength(5)

    const after = await source.listEvents('example-task-002', 2)
    expect(after.events.every((event) => event.eventId > 2)).toBe(true)
  })

  it('已取消的请求以 AbortError 拒绝', async () => {
    const source = sourceFor('M01')
    const controller = new AbortController()
    controller.abort()
    await expect(source.getHealth(controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })
})
