import { describe, expect, it } from 'vitest'
import { RequestGate } from '../src/app/request-gate'

describe('请求归属（乱序丢弃）', () => {
  it('只认最近一次请求，旧 generation 立即失效', () => {
    const gate = new RequestGate()
    const first = gate.next()
    expect(gate.isCurrent(first)).toBe(true)

    const second = gate.next()
    expect(gate.isCurrent(first)).toBe(false)
    expect(gate.isCurrent(second)).toBe(true)
  })

  it('延迟响应到达时已不是当前选择，应被丢弃', async () => {
    const gate = new RequestGate()
    const slow = gate.next()
    const slowResponse = new Promise<string>((resolve) => setTimeout(() => resolve('旧任务'), 20))

    const fast = gate.next()
    void fast

    const value = await slowResponse
    expect(value).toBe('旧任务')
    expect(gate.isCurrent(slow)).toBe(false)
  })
})
