import type {
  ChangeItem,
  CheckResult,
  CheckStatus,
  DisplayState,
  TaskEvent,
  TaskView,
} from '../data/contracts/types'
import type { MockPresentationSupplement } from '../presentation/supplement'
import { formatBytes, formatDateTime, formatLag, remainingCopy } from '../presentation/format'
import { eventLabel } from '../presentation/event-label'

export type TabKey = 'overview' | 'checks' | 'changes' | 'events'

export const TABS: Array<{ key: TabKey; label: string }> = [
  { key: 'overview', label: '概况' },
  { key: 'checks', label: '报告与检查' },
  { key: 'changes', label: '文件变化' },
  { key: 'events', label: '事件' },
]

const CHECK_STATUS_LABEL: Record<CheckStatus, string> = {
  passed: '通过',
  failed: '未通过',
  unknown: '未知',
  not_applicable: '不适用',
  checker_error: '检查器错误',
}

const CHECK_KIND_LABEL: Record<CheckResult['kind'], string> = {
  provenance: '来源',
  scope: '范围',
  command: '命令',
  semantic: '语义',
}

const CHECK_ACTOR_LABEL: Record<CheckResult['actor'], string> = {
  program: '程序',
  independent_reviewer: '独立复核',
  worker: '执行器自报',
}

const CHANGE_KIND_LABEL: Record<ChangeItem['kind'], string> = {
  added: '新增',
  modified: '修改',
  deleted: '删除',
  renamed: '重命名',
}

const CHANGE_CATEGORY_LABEL: Record<ChangeItem['category'], string> = {
  deliverable: '交付物',
  metadata: '元数据',
  unauthorized: '未授权',
}

function reportCopy(state: DisplayState, supplement: MockPresentationSupplement): string {
  if (state === 'accepted') return '已独立验收。'
  if (state === 'needs_review') return '已收到执行报告，尚未独立验收。'
  if (state === 'waiting_stop') return '已收到执行报告，仍在等待原生停止确认。'
  if (supplement.reportSummary !== null) return '已收到执行报告。'
  return '暂无报告信息。'
}

export function OverviewPanel({
  task,
  supplement,
  nowMs,
}: {
  task: TaskView
  supplement: MockPresentationSupplement
  nowMs: number
}) {
  const remaining = remainingCopy(task.timing.attemptDeadlineAt, nowMs)
  return (
    <div className="stack">
      <section className="section">
        <h3 className="section__title">任务目标</h3>
        <p className="text-block">{supplement.objective ?? '暂无信息。'}</p>
      </section>

      <section className="section">
        <h3 className="section__title">允许修改范围</h3>
        {supplement.allowedChangePaths === null ? (
          <p className="text-block text-block--muted">未知（未取得约定范围）。</p>
        ) : supplement.allowedChangePaths.length === 0 ? (
          <p className="text-block text-block--muted">约定不允许修改任何文件。</p>
        ) : (
          <ul className="inline-list">
            {supplement.allowedChangePaths.map((path) => (
              <li key={path} className="mono chip">
                {path}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="section">
        <h3 className="section__title">执行信息</h3>
        <dl className="kv">
          <dt>当前轮次</dt>
          <dd>
            第 {task.attempt.number} / {task.attempt.limit} 轮
          </dd>
          <dt>原生执行来源</dt>
          <dd className="mono">{task.binding.runtimeSource}</dd>
          <dt>停止状态</dt>
          <dd>
            {task.remoteStopped ? '停止已确认' : '停止尚未确认'}
            <span className="kv__hint">
              {task.remoteStopped ? '（有原生停止证据）' : '（未证实停止，不代表仍在运行）'}
            </span>
          </dd>
          <dt>剩余期限</dt>
          <dd className={remaining.expired ? 'text-warn' : undefined}>{remaining.text}</dd>
          <dt>最后观测</dt>
          <dd>{formatDateTime(task.timing.lastObservedAt)}</dd>
        </dl>
      </section>

      <section className="section">
        <h3 className="section__title">最近进展</h3>
        <p className="text-block">{supplement.progressSummary ?? '暂无信息。'}</p>
      </section>

      <section className="section">
        <h3 className="section__title">报告状态</h3>
        <p className="text-block" data-testid="report-status">
          {reportCopy(task.displayState, supplement)}
        </p>
        {supplement.reportSummary !== null ? (
          <p className="text-block text-block--report" data-testid="report-summary">
            {supplement.reportSummary}
          </p>
        ) : null}
      </section>
    </div>
  )
}

export function ChecksPanel({
  task,
  supplement,
}: {
  task: TaskView
  supplement: MockPresentationSupplement
}) {
  return (
    <div className="stack">
      <section className="section">
        <h3 className="section__title">执行报告</h3>
        <p className="text-block">{reportCopy(task.displayState, supplement)}</p>
        {supplement.reportSummary !== null ? (
          <p className="text-block text-block--report">{supplement.reportSummary}</p>
        ) : null}
      </section>

      <section className="section">
        <h3 className="section__title">检查结果</h3>
        {task.checks.length === 0 ? (
          <p className="text-block text-block--muted">尚未记录检查结果。</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th scope="col">检查</th>
                <th scope="col">种类</th>
                <th scope="col">状态</th>
                <th scope="col">记录方</th>
                <th scope="col">检查时间</th>
              </tr>
            </thead>
            <tbody>
              {task.checks.map((check) => (
                <tr key={`${check.checkId}-${check.attemptId}`}>
                  <td>
                    <span className="mono">{check.checkId}</span>
                    <span className="table__sub">
                      {check.evidenceRefs.length === 0 ? '无证据引用' : `${check.evidenceRefs.length} 条证据引用`}
                    </span>
                  </td>
                  <td>{CHECK_KIND_LABEL[check.kind]}</td>
                  <td>
                    <span className={`check-status check-status--${check.status}`}>
                      {CHECK_STATUS_LABEL[check.status]}
                    </span>
                  </td>
                  <td>{CHECK_ACTOR_LABEL[check.actor]}</td>
                  <td>{check.checkedAt === null ? '未知' : formatDateTime(check.checkedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {task.checks.some((check) => check.status === 'unknown' || check.status === 'checker_error') ? (
          <p className="callout callout--warn">
            unknown 与 checker_error 不能当作通过；检查器错误不等于执行器内容失败。
          </p>
        ) : null}
      </section>

      {task.metrics !== null ? (
        <section className="section">
          <h3 className="section__title">成本与用量</h3>
          <dl className="kv">
            <dt>实际积分</dt>
            <dd>{task.metrics.usage.actualCredits === null ? '未知' : task.metrics.usage.actualCredits}</dd>
            <dt>token</dt>
            <dd>{task.metrics.usage.tokens === null ? '未知' : task.metrics.usage.tokens}</dd>
            <dt>活跃推理时间</dt>
            <dd>
              {task.metrics.usage.activeReasoningSeconds === null
                ? '未知'
                : `${task.metrics.usage.activeReasoningSeconds} 秒`}
            </dd>
            <dt>统计完整性</dt>
            <dd>{task.metrics.complete ? '完整' : '不完整'}</dd>
          </dl>
          {task.metrics.limitations.length > 0 ? (
            <ul className="bullet-list">
              {task.metrics.limitations.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : (
        <p className="text-block text-block--muted">尚未提供成本与用量统计。</p>
      )}
    </div>
  )
}

export function ChangesPanel({
  task,
  supplement,
}: {
  task: TaskView
  supplement: MockPresentationSupplement
}) {
  return (
    <div className="stack">
      <section className="section">
        <h3 className="section__title">文件变化</h3>
        {supplement.changesStatus === 'unavailable' ? (
          <p className="text-block text-block--muted" data-testid="changes-unavailable">
            变更信息不可用（未取得文件快照）。
          </p>
        ) : task.changes.length === 0 ? (
          <p className="text-block text-block--muted">未观测到文件变化。</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th scope="col">路径</th>
                <th scope="col">类型</th>
                <th scope="col">分类</th>
                <th scope="col">检查状态</th>
              </tr>
            </thead>
            <tbody>
              {task.changes.map((change) => (
                <tr key={change.path} className={change.category === 'unauthorized' ? 'row--danger' : undefined}>
                  <td className="mono">{change.path}</td>
                  <td>{CHANGE_KIND_LABEL[change.kind]}</td>
                  <td>{CHANGE_CATEGORY_LABEL[change.category]}</td>
                  <td>{CHECK_STATUS_LABEL[change.status as CheckStatus] ?? '未知'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {task.changes.some((change) => change.category === 'unauthorized') ? (
          <p className="callout callout--danger">
            存在未授权文件变化：不能按通过验收，需要独立核对范围。
          </p>
        ) : null}
        {task.changes.some((change) => change.category === 'metadata') ? (
          <p className="callout callout--warn">存在运行元数据写入，与业务交付物分开核对。</p>
        ) : null}
      </section>

      <section className="section">
        <h3 className="section__title">产物</h3>
        {supplement.artifactsStatus === 'unavailable' ? (
          <p className="text-block text-block--muted">产物信息不可用。</p>
        ) : task.artifacts.length === 0 ? (
          <p className="text-block text-block--muted">未登记产物。</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th scope="col">相对路径</th>
                <th scope="col">字节</th>
                <th scope="col">SHA-256</th>
              </tr>
            </thead>
            <tbody>
              {task.artifacts.map((artifact) => (
                <tr key={artifact.artifactId}>
                  <td className="mono">{artifact.relativePath}</td>
                  <td>{formatBytes(artifact.bytes)}</td>
                  <td className="mono mono--truncate" title={artifact.sha256 ?? '未知'}>
                    {artifact.sha256 ?? '未知'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="text-block text-block--muted">
          本页不提供文件下载或本机打开；路径只作为文本展示。
        </p>
      </section>
    </div>
  )
}

const STAGE_TYPES = ['report_received', 'native_stop_confirmed', 'review_recorded'] as const
const STAGE_LABELS: Record<(typeof STAGE_TYPES)[number], string> = {
  report_received: '已回报',
  native_stop_confirmed: '停止确认',
  review_recorded: '独立验收',
}

export function EventsPanel({
  task,
  events,
  loading,
}: {
  task: TaskView
  events: TaskEvent[]
  loading: boolean
}) {
  return (
    <div className="stack">
      <section className="section">
        <h3 className="section__title">阶段</h3>
        <ol className="stage-strip">
          {STAGE_TYPES.map((type) => {
            const found = events.find((event) => event.type === type)
            const state = found ? '已发生' : task.displayState === 'unknown' ? '未知' : '尚未发生'
            return (
              <li key={type} className={`stage stage--${found ? 'done' : 'pending'}`}>
                <span className="stage__label">{STAGE_LABELS[type]}</span>
                <span className="stage__state">{state}</span>
                {found ? <span className="stage__time">{formatDateTime(found.occurredAt)}</span> : null}
              </li>
            )
          })}
        </ol>
        <p className="text-block text-block--muted">
          报告到达、原生停止确认、独立验收是三件不同的事；前一步完成不代表后一步发生。
        </p>
      </section>

      <section className="section">
        <h3 className="section__title">事件时间线</h3>
        {loading ? (
          <p className="text-block text-block--muted">正在读取事件…</p>
        ) : events.length === 0 ? (
          <p className="text-block text-block--muted">暂无事件记录。</p>
        ) : (
          <ol className="timeline">
            {events.map((event) => {
              const lag = formatLag(event.occurredAt, event.observedAt)
              return (
                <li key={event.eventId} className="timeline__item">
                  <span className="timeline__dot" aria-hidden="true" />
                  <div className="timeline__body">
                    <div className="timeline__head">
                      <span className="timeline__label">{eventLabel(event.type)}</span>
                      <span className="timeline__time">{formatDateTime(event.occurredAt, { withSeconds: true })}</span>
                    </div>
                    <div className="timeline__meta">
                      <span className="mono">{event.attemptId}</span> · {event.actor} · eventId {event.eventId}
                    </div>
                    {lag !== null ? <div className="timeline__lag">{lag}</div> : null}
                  </div>
                </li>
              )
            })}
          </ol>
        )}
      </section>
    </div>
  )
}
