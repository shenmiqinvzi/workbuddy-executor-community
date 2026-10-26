import type { DisplayState } from '../data/contracts/types'
import { DISPLAY_STATES } from '../data/contracts/types'

export type DisplayTone = 'neutral' | 'active' | 'attention' | 'success' | 'error' | 'muted'

export interface DisplayStateCopy {
  label: string
  /** 一句话解释：当前发生了什么 */
  explanation: string
  /** 用户下一步该做什么 */
  nextStep: string
  tone: DisplayTone
  /** 只用文字符号，不引入图标库 */
  icon: string
}

export const DISPLAY_STATE_COPY: Record<DisplayState, DisplayStateCopy> = {
  queued: {
    label: '等待领取',
    explanation: '任务已进入队列，等待 WorkBuddy 领取。',
    nextStep: '暂时无需操作，不要重复提交。',
    tone: 'neutral',
    icon: '◷',
  },
  running: {
    label: '正在执行',
    explanation: 'WorkBuddy 已领取任务，正在执行。',
    nextStep: '无需操作，可查看最近进展与最后观测时间。',
    tone: 'active',
    icon: '▶',
  },
  waiting_input: {
    label: '等待你处理',
    explanation: '执行器正在等待原生界面中的权限或输入确认。',
    nextStep: '请到 WorkBuddy 对应会话核对并处理；本页面不能代为批准。',
    tone: 'attention',
    icon: '⏸',
  },
  waiting_stop: {
    label: '等待停止确认',
    explanation: '报告、取消或到期的事实已记录，但尚未取得原生停止证据。',
    nextStep: '暂时无需操作，等待停止确认；不要重新派工。',
    tone: 'attention',
    icon: '⏳',
  },
  needs_review: {
    label: '等待独立验收',
    explanation: '已收到执行报告且停止已确认，等待独立检查与验收。',
    nextStep: '报告到达不等于验收通过，等待独立验收结论。',
    tone: 'neutral',
    icon: '☑',
  },
  accepted: {
    label: '已验收',
    explanation: '该轮交付已独立检查通过。',
    nextStep: '这是该次验收时的快照，不代表文件以后不再变化。',
    tone: 'success',
    icon: '✓',
  },
  cancelled: {
    label: '已取消',
    explanation: '任务已取消并确认停止，不能当作暂停继续执行。',
    nextStep: '如需继续目标，请重新建立任务并说明范围。',
    tone: 'muted',
    icon: '⊘',
  },
  failed: {
    label: '任务未完成',
    explanation: '执行以失败结束，具体原因见报告与检查。',
    nextStep: '查看失败原因与未知项，确认是内容问题还是环境问题。',
    tone: 'error',
    icon: '✕',
  },
  expired: {
    label: '已超过期限',
    explanation: '该轮次已超过绝对期限，期限不会被重连或刷新延长。',
    nextStep: '迟到报告只能查阅，不能按按期成功验收。',
    tone: 'error',
    icon: '⌛',
  },
  unknown: {
    label: '状态待核查',
    explanation: '信息不足，无法确认任务当前状态。',
    nextStep: '核对最后可靠观测与原因，不要推断为成功或失败。',
    tone: 'muted',
    icon: '?',
  },
}

const FALLBACK_COPY: DisplayStateCopy = {
  label: '未知状态，需核查',
  explanation: '后端返回了当前界面不认识的展示状态。',
  nextStep: '保留原始值并核对数据来源，不要推断为完成。',
  tone: 'muted',
  icon: '?',
}

export function isDisplayState(value: string): value is DisplayState {
  return (DISPLAY_STATES as readonly string[]).includes(value)
}

/** 未知枚举必须降级为"需核查"，不能默认映射成已验收。 */
export function copyFor(value: string): DisplayStateCopy {
  if (isDisplayState(value)) return DISPLAY_STATE_COPY[value]
  return FALLBACK_COPY
}

export function isKnownState(value: string): boolean {
  return isDisplayState(value)
}
