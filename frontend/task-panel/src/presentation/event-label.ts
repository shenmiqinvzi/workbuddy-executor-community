import type { EventType } from '../data/contracts/types'

const EVENT_LABELS: Record<EventType, string> = {
  task_received: '任务已接收',
  attempt_queued: '轮次已排队',
  native_claimed: '原生已领取',
  input_requested: '请求原生输入',
  input_resolved: '原生输入已处理',
  report_received: '收到执行报告',
  native_stop_confirmed: '原生停止已确认',
  review_recorded: '独立验收已记录',
  rework_requested: '发起同任务返工',
  cancel_requested: '记录取消请求',
  deadline_exceeded: '到达绝对期限',
  tool_call_finished: '工具调用结束',
  task_closed: '任务已关闭',
  recovery_recorded: '记录恢复操作',
}

export function eventLabel(type: string): string {
  return EVENT_LABELS[type as EventType] ?? `未知事件（${type}）`
}
