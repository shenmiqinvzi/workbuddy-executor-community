import { useState } from 'react'
import type { HealthView, TaskView } from '../data/contracts/types'
import { formatDateTime } from '../presentation/format'

function CopyableValue({ value }: { value: string | null }) {
  const [copied, setCopied] = useState(false)
  if (value === null) return <span className="mono text-muted">未知</span>

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  return (
    <span className="copyable">
      <span className="mono copyable__value" title={value}>
        {value}
      </span>
      <button type="button" className="button button--tiny" onClick={() => void copy()}>
        复制
      </button>
      {copied ? <span className="copyable__done">已复制</span> : null}
    </span>
  )
}

/** 技术身份折叠展示；默认视角不要求用户识别 UUID。 */
export function TechnicalDetails({ task, health }: { task: TaskView; health: HealthView }) {
  return (
    <details className="tech">
      <summary className="tech__summary">技术详情</summary>
      <dl className="kv kv--tech">
        <dt>taskId</dt>
        <dd>
          <CopyableValue value={task.taskId} />
        </dd>
        <dt>attemptId</dt>
        <dd>
          <CopyableValue value={task.attempt.id} />
        </dd>
        <dt>sessionId</dt>
        <dd>
          <CopyableValue value={task.binding.sessionId} />
        </dd>
        <dt>revision</dt>
        <dd>
          <CopyableValue value={task.revision} />
        </dd>
        <dt>原始业务状态</dt>
        <dd className="mono">{task.businessState}</dd>
        <dt>原始展示状态</dt>
        <dd className="mono">{String(task.displayState)}</dd>
        <dt>runtimeSource</dt>
        <dd className="mono">{task.binding.runtimeSource}</dd>
        <dt>lastObservedAt</dt>
        <dd className="mono">{task.timing.lastObservedAt ?? '未知'}</dd>
        <dt>快照时间</dt>
        <dd className="mono">{health.asOf === null ? '未知' : formatDateTime(health.asOf)}</dd>
      </dl>
      <p className="text-block text-block--muted">
        这些标识用于核对身份与证据；日常定位依靠标题和项目，不需要复制 UUID。
      </p>
    </details>
  )
}
