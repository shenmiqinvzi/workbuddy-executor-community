import type { DisplayState, HealthView, TaskView } from '../data/contracts/types'
import { DISPLAY_STATES } from '../data/contracts/types'
import { copyFor, isDisplayState } from '../presentation/display-state'
import { formatRelative } from '../presentation/format'
import { StatusBadge } from './status-badge'

export interface ListFilters {
  search: string
  projectId: string | null
  displayState: DisplayState | null
}

export interface ProjectOption {
  id: string
  name: string
}

export interface TaskListProps {
  tasks: TaskView[]
  projects: ProjectOption[]
  loading: boolean
  error: string | null
  selectedTaskId: string | null
  filters: ListFilters
  hasActiveFilter: boolean
  nowMs: number
  health: HealthView
  onSelect: (taskId: string) => void
  onFiltersChange: (filters: ListFilters) => void
  onClearFilters: () => void
}

export function TaskList({
  tasks,
  projects,
  loading,
  error,
  selectedTaskId,
  filters,
  hasActiveFilter,
  nowMs,
  health,
  onSelect,
  onFiltersChange,
  onClearFilters,
}: TaskListProps) {
  return (
    <section className="panel task-list" aria-label="任务列表">
      <div className="task-list__header">
        <h2 className="panel__title">任务</h2>
        <span className="task-list__count" data-testid="task-count">
          {loading ? '读取中' : `${tasks.length} 条`}
        </span>
      </div>

      <div className="task-list__filters">
        <label className="field">
          <span className="field__label">搜索标题</span>
          <input
            className="input"
            type="search"
            value={filters.search}
            placeholder="只匹配标题"
            onChange={(event) => onFiltersChange({ ...filters, search: event.target.value })}
            aria-label="搜索任务标题"
          />
        </label>
        <div className="task-list__filter-row">
          <label className="field field--compact">
            <span className="field__label">项目</span>
            <select
              className="select"
              value={filters.projectId ?? ''}
              onChange={(event) => onFiltersChange({ ...filters, projectId: event.target.value || null })}
              aria-label="按项目筛选"
            >
              <option value="">全部项目</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field field--compact">
            <span className="field__label">状态</span>
            <select
              className="select"
              value={filters.displayState ?? ''}
              onChange={(event) => {
                const value = event.target.value
                onFiltersChange({ ...filters, displayState: isDisplayState(value) ? value : null })
              }}
              aria-label="按状态筛选"
            >
              <option value="">全部状态</option>
              {DISPLAY_STATES.map((state) => (
                <option key={state} value={state}>
                  {copyFor(state).label}
                </option>
              ))}
            </select>
          </label>
        </div>
        {hasActiveFilter ? (
          <button type="button" className="button button--link" onClick={onClearFilters}>
            清除筛选
          </button>
        ) : null}
      </div>

      {loading ? (
        <ul className="task-list__items" aria-busy="true" aria-label="任务加载中">
          {[0, 1, 2].map((key) => (
            <li key={key} className="task-item task-item--skeleton">
              <span className="skeleton-line skeleton-line--wide" />
              <span className="skeleton-line" />
            </li>
          ))}
        </ul>
      ) : error !== null ? (
        <p className="empty-state" role="alert">
          {error}
          <span className="empty-state__hint">可在顶部点击"刷新模拟快照"重试。</span>
        </p>
      ) : tasks.length === 0 ? (
        hasActiveFilter ? (
          <div className="empty-state" data-testid="no-match">
            没有匹配的任务
            <button type="button" className="button button--link" onClick={onClearFilters}>
              清除筛选
            </button>
          </div>
        ) : (
          <p className="empty-state" data-testid="empty-list">
            暂无任务。本页当前使用模拟数据，可切换场景查看示例。
          </p>
        )
      ) : (
        <ul className="task-list__items">
          {tasks.map((task) => {
            const active = task.taskId === selectedTaskId
            const copy = copyFor(task.displayState)
            return (
              <li key={task.taskId}>
                <button
                  type="button"
                  className={`task-item${active ? ' task-item--active' : ''}`}
                  onClick={() => onSelect(task.taskId)}
                  aria-current={active ? 'true' : undefined}
                >
                  <span className="task-item__top">
                    <span className="task-item__title" title={task.title}>
                      {task.title}
                    </span>
                    {active ? <span className="task-item__selected">已选中</span> : null}
                  </span>
                  <span className="task-item__meta">
                    <StatusBadge state={task.displayState} size="sm" />
                    <span className="task-item__project">{task.workspace.displayName}</span>
                    <span className="task-item__round">
                      第 {task.attempt.number} / {task.attempt.limit} 轮
                    </span>
                  </span>
                  <span className="task-item__observed">
                    最后观测：{formatRelative(task.timing.lastObservedAt, nowMs)}
                    {health.status === 'interrupted' || health.status === 'stale' ? '（旧快照）' : ''}
                    <span className="visually-hidden">状态说明：{copy.explanation}</span>
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
