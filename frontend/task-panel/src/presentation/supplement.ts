/**
 * 面板补充 mock 数据。
 *
 * 目标 TaskView（接口契约 §3）没有定义"任务目标正文、进度摘要、报告正文、
 * 允许修改范围、变更/产物是否已观测"。这些字段不是正式 wire 字段，
 * 后续需要显式契约变更后才能从真实接口获取。
 */
export interface MockPresentationSupplement {
  objective: string | null
  progressSummary: string | null
  reportSummary: string | null
  allowedChangePaths: string[] | null
  changesStatus: 'observed' | 'unavailable'
  artifactsStatus: 'observed' | 'unavailable'
}

export const EMPTY_SUPPLEMENT: MockPresentationSupplement = {
  objective: null,
  progressSummary: null,
  reportSummary: null,
  allowedChangePaths: null,
  changesStatus: 'unavailable',
  artifactsStatus: 'unavailable',
}
