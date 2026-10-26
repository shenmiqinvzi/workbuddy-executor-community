import type { DemoState } from '../demo/demo-controller'
import type { HealthView } from '../data/contracts/types'
import type { MockScenario } from '../data/mock/scenarios'
import { formatEpoch } from '../presentation/format'

const HEALTH_COPY: Record<HealthView['status'], string> = {
  ok: '模拟连接：正常',
  loading: '模拟连接：加载中',
  interrupted: '模拟连接：连接中断',
  stale: '模拟连接：数据已过期',
}

export interface TopBarProps {
  scenarios: MockScenario[]
  state: DemoState
  health: HealthView
  scenario: MockScenario
  refreshedAtMs: number | null
  onScenarioChange: (id: string) => void
  onPlay: () => void
  onPause: () => void
  onPrev: () => void
  onNext: () => void
  onReset: () => void
  onRefresh: () => void
}

export function TopBar({
  scenarios,
  state,
  health,
  scenario,
  refreshedAtMs,
  onScenarioChange,
  onPlay,
  onPause,
  onPrev,
  onNext,
  onReset,
  onRefresh,
}: TopBarProps) {
  const atFirst = state.frameIndex === 0
  const atLast = state.frameIndex >= state.frameCount - 1

  return (
    <header className="topbar">
      <div className="topbar__row topbar__row--primary">
        <div className="topbar__brand">
          <span className="topbar__product">WorkBuddy Executor</span>
          <span className="topbar__subtitle">只读任务面板</span>
          <span className="mock-badge">模拟数据</span>
        </div>
        <span className={`connection connection--${health.status}`} data-testid="connection-status">
          {HEALTH_COPY[health.status]}
        </span>
      </div>

      <div className="topbar__row topbar__row--controls">
        <label className="field">
          <span className="field__label">场景</span>
          <select
            className="select"
            value={state.scenarioId}
            onChange={(event) => onScenarioChange(event.target.value)}
            aria-label="选择模拟场景"
          >
            {scenarios.map((item) => (
              <option key={item.id} value={item.id}>
                {item.id} · {item.title}
              </option>
            ))}
          </select>
        </label>

        <div className="demo-controls" role="group" aria-label="演示播放控制">
          <button type="button" className="button" onClick={onPrev} disabled={atFirst}>
            上一帧
          </button>
          {state.playing ? (
            <button type="button" className="button" onClick={onPause}>
              暂停
            </button>
          ) : (
            <button type="button" className="button" onClick={onPlay}>
              播放
            </button>
          )}
          <button type="button" className="button" onClick={onNext} disabled={atLast}>
            下一帧
          </button>
          <button type="button" className="button button--ghost" onClick={onReset}>
            重新播放
          </button>
          <button type="button" className="button button--ghost" onClick={onRefresh}>
            刷新模拟快照
          </button>
        </div>

        <div className="demo-clock">
          <span className="demo-clock__frame" data-testid="frame-indicator">
            第 {state.frameIndex + 1} / {state.frameCount} 帧
          </span>
          <span className="demo-clock__now">
            演示时刻 {formatEpoch(state.clockMs)}
          </span>
          <span className="demo-clock__refreshed" data-testid="refreshed-at">
            {refreshedAtMs === null
              ? '尚未刷新'
              : `刚刚刷新 ${formatEpoch(refreshedAtMs)}`}
          </span>
        </div>
      </div>

      <p className="topbar__summary">{scenario.summary}</p>
      {health.message !== null ? <p className="topbar__health-note">{health.message}</p> : null}
    </header>
  )
}
