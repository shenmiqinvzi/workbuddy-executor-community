const UNKNOWN_TIME = '时间未知'

function parse(iso: string | null): number | null {
  if (iso === null) return null
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? null : ms
}

/** 把 UTC ISO 转成本地时间展示；非法或缺省都返回"时间未知"。 */
export function formatDateTime(
  iso: string | null,
  options: { timeZone?: string; withSeconds?: boolean } = {},
): string {
  const ms = parse(iso)
  if (ms === null) return UNKNOWN_TIME
  const formatter = new Intl.DateTimeFormat('zh-CN', {
    timeZone: options.timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: options.withSeconds ? '2-digit' : undefined,
    hour12: false,
  })
  return formatter.format(new Date(ms))
}

/** 相对"最后观测"：只描述过去，不用当前时间填充未知。 */
export function formatRelative(iso: string | null, nowMs: number): string {
  const ms = parse(iso)
  if (ms === null) return UNKNOWN_TIME
  const diff = nowMs - ms
  if (diff < 0) return '刚刚'
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return `${seconds} 秒前`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}

/** 把毫秒时间戳按本地时区展示（组件不直接 new Date）。 */
export function formatEpoch(ms: number, options: { withSeconds?: boolean } = {}): string {
  if (!Number.isFinite(ms)) return UNKNOWN_TIME
  return formatDateTime(new Date(ms).toISOString(), options)
}

export interface RemainingCopy {
  known: boolean
  expired: boolean
  text: string
}

/** 剩余期限：缺失/非法 → unknown；到期 → 等待服务端确认，前端不改业务状态。 */
export function remainingCopy(deadlineIso: string | null, nowMs: number): RemainingCopy {
  const ms = parse(deadlineIso)
  if (ms === null) {
    return { known: false, expired: false, text: '期限未知' }
  }
  const diff = ms - nowMs
  if (diff <= 0) {
    return { known: true, expired: true, text: '期限已到，等待服务端确认状态' }
  }
  const totalSeconds = Math.floor(diff / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  const text = hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`
  return { known: true, expired: false, text: `剩余 ${text}` }
}

/** 字节数：未知保持"未知"，不显示 0。 */
export function formatBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return '未知'
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(1)} KB`
  return `${(kb / 1024).toFixed(1)} MB`
}

/** 观测滞后：事件发生到被观察到的时间差。 */
export function formatLag(occurredAt: string | null, observedAt: string | null): string | null {
  const occurred = parse(occurredAt)
  const observed = parse(observedAt)
  if (occurred === null || observed === null) return null
  const diff = observed - occurred
  if (diff < 5000) return null
  const minutes = Math.floor(diff / 60000)
  if (minutes >= 1) return `稍后观测到（+${minutes} 分钟）`
  return `稍后观测到（+${Math.round(diff / 1000)} 秒）`
}
