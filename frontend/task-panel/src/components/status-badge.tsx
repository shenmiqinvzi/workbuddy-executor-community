import { copyFor } from '../presentation/display-state'

interface StatusBadgeProps {
  state: string
  size?: 'sm' | 'md' | 'lg'
  showCheck?: boolean
}

/** 状态徽标：文字 + 图标，绝不只靠颜色区分。 */
export function StatusBadge({ state, size = 'md', showCheck = false }: StatusBadgeProps) {
  const copy = copyFor(state)
  return (
    <span className={`status-badge status-badge--${size} tone-${copy.tone}`}>
      <span className="status-badge__icon" aria-hidden="true">
        {copy.icon}
      </span>
      <span>{copy.label}</span>
      {showCheck && !isKnown(state) ? (
        <span className="status-badge__hint" title="后端返回了未识别的展示状态">
          需核查
        </span>
      ) : null}
    </span>
  )
}

function isKnown(state: string): boolean {
  return copyFor(state).label !== '未知状态，需核查'
}
