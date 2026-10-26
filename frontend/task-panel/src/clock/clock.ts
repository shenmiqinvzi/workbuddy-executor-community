/** 可注入时钟：倒计时与"最后观测"必须基于它，而不是各处直接 new Date()。 */
export interface Clock {
  now(): Date
}

export class FixedClock implements Clock {
  private ms: number

  constructor(initial: string | number) {
    this.ms = typeof initial === 'string' ? Date.parse(initial) : initial
    if (Number.isNaN(this.ms)) {
      throw new Error(`FixedClock 初始化时间无效: ${String(initial)}`)
    }
  }

  now(): Date {
    return new Date(this.ms)
  }

  get timeMs(): number {
    return this.ms
  }

  set(ms: number): void {
    this.ms = ms
  }

  advance(deltaMs: number): void {
    this.ms += deltaMs
  }
}

export const systemClock: Clock = {
  now: () => new Date(),
}
