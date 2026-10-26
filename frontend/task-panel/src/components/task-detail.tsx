import type { KeyboardEvent } from 'react'
import type { HealthView, TaskEvent, TaskView } from '../data/contracts/types'
import type { MockPresentationSupplement } from '../presentation/supplement'
import { copyFor } from '../presentation/display-state'
import { formatDateTime, formatRelative, remainingCopy } from '../presentation/format'
import { StatusBadge } from './status-badge'
import { TechnicalDetails } from './technical-details'
import {
  ChangesPanel,
  ChecksPanel,
  EventsPanel,
  OverviewPanel,
  TABS,
  type TabKey,
} from './tabs'

const STALE_OBSERVATION_MS = 15_000

/** 终态任务不再有"剩余期限"与"观测是否陈旧"的实时含义 */
const TERMINAL_STATES = new Set(['accepted', 'cancelled', 'failed'])
const LIVE_OBSERVATION_STATES = new Set(['queued', 'running', 'waiting_input', 'waiting_stop', 'unknown'])

export interface TaskDetailProps {
  task: TaskView | null
  loading: boolean
  error: string | null
  supplement: MockPresentationSupplement
  health: HealthView
  nowMs: number
  events: TaskEvent[]
  eventsLoading: boolean
  tab: TabKey
  onTabChange: (tab: TabKey) => void
  onRetry: () => void
  onBackToList: () => void
}

function DataQualityWarnings({
  task,
  health,
  nowMs,
}: {
  task: TaskView
  health: HealthView
  nowMs: number
}) {
  const copy = copyFor(task.displayState)
  const warnings: string[] = []

  if (health.status === 'interrupted' || health.status === 'stale') {
    warnings.push('连接中断，仅显示旧快照；状态不会被自动推进。')
  }
  const observedMs = task.timing.lastObservedAt === null ? null : Date.parse(task.timing.lastObservedAt)
  if (LIVE_OBSERVATION_STATES.has(task.displayState)) {
    if (observedMs === null || Number.isNaN(observedMs)) {
      warnings.push('观测时间未知，不能推断任务当前是否在运行。')
    } else if (nowMs - observedMs > STALE_OBSERVATION_MS) {
      warnings.push('观测信息较旧（超过 15 秒没有新观测）。')
    }
  }
  if (task.displayState === 'needs_review' && !task.remoteStopped) {
    warnings.push('数据不一致：状态为待验收，但没有任何原生停止证据。')
  }
  if (task.displayState === 'accepted' && task.timing.reviewedAt === null) {
    warnings.push('数据不一致：状态为已验收，但没有验收时间。')
  }
  if (task.displayState === 'running' && task.remoteStopped) {
    warnings.push('数据不一致：已确认停止，却仍显示正在执行。')
  }
  if (copy.label === '未知状态，需核查') {
    warnings.push(`后端返回了未识别的展示状态：${String(task.displayState)}。`)
  }

  if (warnings.length === 0) return null
  return (
    <div className="warnings" role="status">
      {warnings.map((warning) => (
        <p key={warning} className="callout callout--warn">
          {warning}
        </p>
      ))}
    </div>
  )
}

function BlockerBox({ task }: { task: TaskView }) {
  const blocker = task.blocker
  if (blocker === null) return null

  return (
    <section className="blocker" aria-label="阻塞原因">
      <h3 className="section__title">需要处理</h3>
      <p className="blocker__summary">{blocker.summary}</p>
      {blocker.detailsStatus === 'unavailable' ? (
        <p className="text-block text-block--muted" data-testid="blocker-unknown">
          具体请求详情不可用；请到原生会话核查，不要根据本页猜测权限类型。
        </p>
      ) : (
        <dl className="kv">
          {blocker.sessionTitle !== null ? (
            <>
              <dt>会话标题</dt>
              <dd>{blocker.sessionTitle}</dd>
            </>
          ) : null}
          {blocker.toolName !== null ? (
            <>
              <dt>工具</dt>
              <dd className="mono">{blocker.toolName}</dd>
            </>
          ) : null}
          {blocker.commandSummary !== null ? (
            <>
              <dt>请求摘要</dt>
              <dd className="mono">{blocker.commandSummary}</dd>
            </>
          ) : null}
          {blocker.targetPath !== null ? (
            <>
              <dt>目标路径</dt>
              <dd className="mono">{blocker.targetPath}</dd>
            </>
          ) : null}
          <dt>处理位置</dt>
          <dd>{blocker.resolutionChannel === 'native_ui' ? 'WorkBuddy 原生界面' : '未知'}</dd>
        </dl>
      )}
      <p className="text-block text-block--muted">
        {blocker.canRespondViaGateway
          ? '该执行器声明可由网关处理，但本原型不提供任何代为确认的操作。'
          : '本页面不能代为批准原生权限；请在 WorkBuddy 对应会话中处理。'}
      </p>
    </section>
  )
}

function TabBar({ active, onChange }: { active: TabKey; onChange: (tab: TabKey) => void }) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = TABS.findIndex((tab) => tab.key === active)
    if (event.key === 'ArrowRight') {
      event.preventDefault()
      onChange(TABS[(index + 1) % TABS.length]!.key)
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault()
      onChange(TABS[(index - 1 + TABS.length) % TABS.length]!.key)
    } else if (event.key === 'Home') {
      event.preventDefault()
      onChange(TABS[0]!.key)
    } else if (event.key === 'End') {
      event.preventDefault()
      onChange(TABS[TABS.length - 1]!.key)
    }
  }

  return (
    <div className="tabs" role="tablist" aria-label="任务详情分区" onKeyDown={onKeyDown}>
      {TABS.map((tab) => (
        <button
          key={tab.key}
          type="button"
          role="tab"
          id={`tab-${tab.key}`}
          aria-selected={active === tab.key}
          aria-controls={`panel-${tab.key}`}
          tabIndex={active === tab.key ? 0 : -1}
          className={`tabs__tab${active === tab.key ? ' tabs__tab--active' : ''}`}
          onClick={() => onChange(tab.key)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  )
}

export function TaskDetail({
  task,
  loading,
  error,
  supplement,
  health,
  nowMs,
  events,
  eventsLoading,
  tab,
  onTabChange,
  onRetry,
  onBackToList,
}: TaskDetailProps) {
  if (error !== null) {
    return (
      <section className="panel detail" aria-label="任务详情">
        <div className="empty-state" role="alert">
          {error}
          <button type="button" className="button button--link" onClick={onRetry}>
            重新读取模拟快照
          </button>
        </div>
      </section>
    )
  }

  if (task === null) {
    return (
      <section className="panel detail" aria-label="任务详情">
        <p className="empty-state">{loading ? '正在读取任务…' : '选择左侧任务查看详情。'}</p>
      </section>
    )
  }

  const copy = copyFor(task.displayState)
  const remaining = TERMINAL_STATES.has(task.displayState)
    ? { known: true, expired: false, text: '期限已结束（已进入终态）' }
    : remainingCopy(task.timing.attemptDeadlineAt, nowMs)

  return (
    <section className="panel detail" aria-label="任务详情">
      <header className="detail__header">
        <button type="button" className="button button--link detail__back" onClick={onBackToList}>
          ← 返回任务列表
        </button>
        <h2 className="detail__title" data-testid="detail-title">
          {task.title}
        </h2>
        <p className="detail__sub">
          {task.workspace.displayName} · 第 {task.attempt.number} / {task.attempt.limit} 轮
        </p>
      </header>

      <section className="status" aria-label="当前状态">
        <StatusBadge state={task.displayState} size="lg" showCheck />
        <p className="status__explanation">{copy.explanation}</p>
        <p className="status__next" aria-live="polite" data-testid="status-next">
          {copy.nextStep}
        </p>
        <p className="status__meta">
          <span>
            最后观测：{formatRelative(task.timing.lastObservedAt, nowMs)}
            {task.timing.lastObservedAt !== null ? `（${formatDateTime(task.timing.lastObservedAt, { withSeconds: true })}）` : ''}
          </span>
          <span className={remaining.expired ? 'text-warn' : undefined} data-testid="remaining">
            {remaining.text}
          </span>
        </p>
      </section>

      <DataQualityWarnings task={task} health={health} nowMs={nowMs} />
      <BlockerBox task={task} />

      <TabBar active={tab} onChange={onTabChange} />

      <div
        className="tab-panel"
        role="tabpanel"
        id={`panel-${tab}`}
        aria-labelledby={`tab-${tab}`}
        tabIndex={0}
      >
        {tab === 'overview' ? <OverviewPanel task={task} supplement={supplement} nowMs={nowMs} /> : null}
        {tab === 'checks' ? <ChecksPanel task={task} supplement={supplement} /> : null}
        {tab === 'changes' ? <ChangesPanel task={task} supplement={supplement} /> : null}
        {tab === 'events' ? <EventsPanel task={task} events={events} loading={eventsLoading} /> : null}
      </div>

      <TechnicalDetails task={task} health={health} />
    </section>
  )
}
