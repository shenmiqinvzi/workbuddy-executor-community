import { describe, expect, it } from 'vitest'
import {
  formatBytes,
  formatDateTime,
  formatLag,
  formatRelative,
  remainingCopy,
} from '../src/presentation/format'

const NOW = Date.parse('2026-10-20T01:10:00Z')
const iso = (ms: number) => new Date(ms).toISOString()

describe('时间与数值格式', () => {
  it('缺失与非法时间都显示"时间未知"，不用当前时间填充', () => {
    expect(formatDateTime(null)).toBe('时间未知')
    expect(formatDateTime('not-a-date')).toBe('时间未知')
    expect(formatRelative(null, NOW)).toBe('时间未知')
    expect(formatLag(null, null)).toBeNull()
  })

  it('按指定时区展示本地时间', () => {
    expect(formatDateTime('2026-10-20T01:10:00Z', { timeZone: 'Asia/Shanghai' })).toBe('2026/10/20 09:10')
  })

  it('相对时间只描述过去', () => {
    expect(formatRelative(iso(NOW - 10_000), NOW)).toBe('10 秒前')
    expect(formatRelative(iso(NOW - 120_000), NOW)).toBe('2 分钟前')
    expect(formatRelative(iso(NOW + 30_000), NOW)).toBe('刚刚')
  })

  it('倒计时区分未知、正常与到期', () => {
    expect(remainingCopy(null, NOW)).toEqual({ known: false, expired: false, text: '期限未知' })
    expect(remainingCopy('bad-date', NOW).text).toBe('期限未知')
    expect(remainingCopy(iso(NOW + 260_000), NOW).text).toBe('剩余 04:20')
    const expired = remainingCopy(iso(NOW - 1000), NOW)
    expect(expired.expired).toBe(true)
    expect(expired.text).toBe('期限已到，等待服务端确认状态')
  })

  it('字节数未知不显示 0，已知零显示 0 B', () => {
    expect(formatBytes(null)).toBe('未知')
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
  })

  it('观测滞后超过 5 秒才提示', () => {
    expect(formatLag(iso(NOW), iso(NOW + 2000))).toBeNull()
    expect(formatLag(iso(NOW), iso(NOW + 120_000))).toBe('稍后观测到（+2 分钟）')
  })
})
