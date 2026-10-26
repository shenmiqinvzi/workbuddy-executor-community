import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { TaskEvent, TaskView, HealthView } from '../data/contracts/types'
import { SCENARIOS } from '../data/mock/scenarios'
import { MockPanelDataSource } from '../data/mock/mock-panel-data-source'
import { DemoController } from '../demo/demo-controller'
import { RequestGate } from './request-gate'
import type { MockPresentationSupplement } from '../presentation/supplement'
import { EMPTY_SUPPLEMENT } from '../presentation/supplement'
import { TopBar } from '../components/top-bar'
import { TaskList, type ListFilters, type ProjectOption } from '../components/task-list'
import { TaskDetail } from '../components/task-detail'
import type { TabKey } from '../components/tabs'

export interface AppProps {
  /** 测试注入用；不传时自行创建默认控制器 */
  controller?: DemoController
}

const INITIAL_FILTERS: ListFilters = { search: '', projectId: null, displayState: null }

export function App({ controller }: AppProps) {
  const demo = useMemo(() => {
    if (controller !== undefined) return controller
    const params = new URLSearchParams(window.location.search)
    const instance = new DemoController(SCENARIOS, params.get('scene') ?? undefined)
    const frame = Number(params.get('frame'))
    if (Number.isInteger(frame) && frame > 0) instance.selectFrame(frame)
    return instance
  }, [controller])
  const state = useSyncExternalStore(demo.subscribe, demo.getState)
  const scenario = demo.getScenario()
  const source = useMemo(() => new MockPanelDataSource(() => demo.snapshot()), [demo])
  const listGate = useMemo(() => new RequestGate(), [])
  const detailGate = useMemo(() => new RequestGate(), [])

  const [health, setHealth] = useState<HealthView>(() => demo.snapshot().health)
  const [tasks, setTasks] = useState<TaskView[]>([])
  const [listLoading, setListLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [task, setTask] = useState<TaskView | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [events, setEvents] = useState<TaskEvent[]>([])
  const [eventsLoading, setEventsLoading] = useState(false)
  const [tab, setTab] = useState<TabKey>('overview')
  const [filters, setFilters] = useState<ListFilters>(INITIAL_FILTERS)
  const [refreshedAtMs, setRefreshedAtMs] = useState<number | null>(null)

  useEffect(() => {
    if (controller !== undefined) return
    return () => demo.dispose()
  }, [demo, controller])

  /* 页签从后台恢复：按真实经过时间补齐演示时钟 */
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') demo.resumeVisible()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => document.removeEventListener('visibilitychange', onVisibilityChange)
  }, [demo])

  /* 连接状态 */
  useEffect(() => {
    let cancelled = false
    void source
      .getHealth()
      .then((next) => {
        if (!cancelled) setHealth(next)
      })
      .catch(() => {
        /* 健康状态读取失败时保留上一次快照 */
      })
    return () => {
      cancelled = true
    }
  }, [source, state.scenarioId, state.frameIndex, state.refreshCount])

  /* 列表：筛选条件或帧变化时重读，旧响应由 generation 丢弃 */
  useEffect(() => {
    const generation = listGate.next()
    setListLoading(true)
    setListError(null)
    void source
      .listTasks({
        search: filters.search,
        projectId: filters.projectId,
        displayState: filters.displayState,
      })
      .then((page) => {
        if (!listGate.isCurrent(generation)) return
        setTasks(page.tasks)
        setListLoading(false)
      })
      .catch((error: unknown) => {
        if (!listGate.isCurrent(generation)) return
        if (error instanceof DOMException && error.name === 'AbortError') return
        setListError('读取模拟任务列表失败。')
        setListLoading(false)
      })
  }, [source, listGate, state.scenarioId, state.frameIndex, state.refreshCount, filters])

  /* 选中项始终属于当前列表；否则回退到第一条 */
  useEffect(() => {
    if (listLoading) return
    setSelectedTaskId((previous) => {
      if (previous !== null && tasks.some((item) => item.taskId === previous)) return previous
      return tasks[0]?.taskId ?? null
    })
  }, [tasks, listLoading])

  /* 详情：只认最近一次选择 */
  useEffect(() => {
    if (selectedTaskId === null) {
      setTask(null)
      setDetailError(null)
      setDetailLoading(false)
      return
    }
    const generation = detailGate.next()
    setDetailLoading(true)
    setDetailError(null)
    void source
      .getTask(selectedTaskId)
      .then((next) => {
        if (!detailGate.isCurrent(generation)) return
        setTask(next)
        setDetailLoading(false)
      })
      .catch((error: unknown) => {
        if (!detailGate.isCurrent(generation)) return
        if (error instanceof DOMException && error.name === 'AbortError') return
        setDetailError('读取任务详情失败。')
        setDetailLoading(false)
      })
  }, [source, detailGate, selectedTaskId, state.scenarioId, state.frameIndex, state.refreshCount])

  /* 事件：只在需要时读取，换任务先清空 */
  useEffect(() => {
    if (selectedTaskId === null || tab !== 'events') return
    let cancelled = false
    setEvents([])
    setEventsLoading(true)
    void source
      .listEvents(selectedTaskId, 0)
      .then((page) => {
        if (cancelled) return
        setEvents(page.events)
        setEventsLoading(false)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        if (error instanceof DOMException && error.name === 'AbortError') return
        setEventsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [source, selectedTaskId, tab, state.scenarioId, state.frameIndex, state.refreshCount])

  const projects = useMemo<ProjectOption[]>(() => {
    const map = new Map<string, string>()
    for (const item of demo.currentFrame.tasks) {
      map.set(item.workspace.id, item.workspace.displayName)
    }
    return Array.from(map, ([id, name]) => ({ id, name }))
  }, [demo, state.scenarioId, state.frameIndex, state.refreshCount])

  const supplement: MockPresentationSupplement = useMemo(
    () => (selectedTaskId === null ? EMPTY_SUPPLEMENT : demo.getSupplement(selectedTaskId)),
    [demo, selectedTaskId, state.scenarioId, state.frameIndex, state.refreshCount],
  )

  const hasActiveFilter =
    filters.search.trim() !== '' || filters.projectId !== null || filters.displayState !== null

  const handleSelectTask = (taskId: string) => {
    setSelectedTaskId(taskId)
    if (typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 767px)').matches) {
      document.querySelector('.detail')?.scrollIntoView({ block: 'start' })
    }
  }

  const handleBackToList = () => {
    document.querySelector('.task-list')?.scrollIntoView({ block: 'start' })
  }

  const handleRefresh = () => {
    demo.refresh()
    setRefreshedAtMs(demo.getState().clockMs)
  }

  return (
    <div className="app">
      <TopBar
        scenarios={demo.getScenarios()}
        state={state}
        health={health}
        scenario={scenario}
        refreshedAtMs={refreshedAtMs}
        onScenarioChange={(id) => demo.selectScenario(id)}
        onPlay={() => demo.play()}
        onPause={() => demo.pause()}
        onPrev={() => demo.prevFrame()}
        onNext={() => demo.nextFrame()}
        onReset={() => demo.reset()}
        onRefresh={handleRefresh}
      />

      <main className="layout">
        <TaskList
          tasks={tasks}
          projects={projects}
          loading={listLoading}
          error={listError}
          selectedTaskId={selectedTaskId}
          filters={filters}
          hasActiveFilter={hasActiveFilter}
          nowMs={state.clockMs}
          health={health}
          onSelect={handleSelectTask}
          onFiltersChange={(next) => setFilters(next)}
          onClearFilters={() => setFilters(INITIAL_FILTERS)}
        />
        <TaskDetail
          task={task}
          loading={detailLoading}
          error={detailError}
          supplement={supplement}
          health={health}
          nowMs={state.clockMs}
          events={events}
          eventsLoading={eventsLoading}
          tab={tab}
          onTabChange={(next) => setTab(next)}
          onRetry={handleRefresh}
          onBackToList={handleBackToList}
        />
      </main>

      <footer className="app__footer">
        本页面只使用合成数据，不连接真实 WorkBuddy、任务数据库或网关执行接口；所有状态均为演示用途。
      </footer>
    </div>
  )
}
