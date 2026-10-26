import { FixedClock } from '../clock/clock'
import type { FrameSnapshot } from '../data/mock/mock-panel-data-source'
import type { MockFrame, MockScenario } from '../data/mock/scenarios'
import { EMPTY_SUPPLEMENT, type MockPresentationSupplement } from '../presentation/supplement'

export interface DemoState {
  scenarioId: string
  frameIndex: number
  frameCount: number
  playing: boolean
  /** 当前演示时钟（毫秒） */
  clockMs: number
  refreshCount: number
}

const TICK_MS = 1000

/**
 * 演示控制器：场景选择、帧播放、固定演示时钟。
 * 它只改变"看哪一帧"，不修改任何任务事实；重置也只重置演示时钟与帧指针。
 */
export class DemoController {
  private readonly scenarios: MockScenario[]
  private scenario: MockScenario
  private frameIndex = 0
  private readonly clock: FixedClock
  private playing = false
  private timer: ReturnType<typeof setInterval> | null = null
  private refreshCount = 0
  private lastTickWall = 0
  private readonly listeners = new Set<() => void>()
  private state: DemoState

  constructor(scenarios: MockScenario[], initialScenarioId?: string) {
    if (scenarios.length === 0) {
      throw new Error('至少需要一个模拟场景')
    }
    this.scenarios = scenarios
    this.scenario = scenarios.find((item) => item.id === initialScenarioId) ?? scenarios[0]!
    this.clock = new FixedClock(this.scenario.fixtureNow)
    this.state = this.buildState()
  }

  private buildState(): DemoState {
    return {
      scenarioId: this.scenario.id,
      frameIndex: this.frameIndex,
      frameCount: this.scenario.frames.length,
      playing: this.playing,
      clockMs: this.clock.timeMs,
      refreshCount: this.refreshCount,
    }
  }

  private publish(): void {
    this.state = this.buildState()
    for (const listener of this.listeners) listener()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getState = (): DemoState => this.state

  getScenarios(): MockScenario[] {
    return this.scenarios
  }

  getScenario(): MockScenario {
    return this.scenario
  }

  get currentFrame(): MockFrame {
    return this.scenario.frames[this.frameIndex] ?? this.scenario.frames[0]!
  }

  getSupplement(taskId: string): MockPresentationSupplement {
    return this.currentFrame.supplements[taskId] ?? EMPTY_SUPPLEMENT
  }

  snapshot(): FrameSnapshot {
    const frame = this.currentFrame
    return {
      tasks: frame.tasks,
      events: frame.events,
      health: frame.health,
      asOf: frame.health.asOf,
      supplements: frame.supplements,
    }
  }

  selectScenario(id: string): void {
    const next = this.scenarios.find((item) => item.id === id)
    if (!next || next.id === this.scenario.id) return
    this.pause()
    this.scenario = next
    this.frameIndex = 0
    this.refreshCount = 0
    this.clock.set(Date.parse(next.fixtureNow))
    this.publish()
  }

  selectFrame(index: number): void {
    if (index < 0 || index >= this.scenario.frames.length) return
    this.pause()
    this.frameIndex = index
    const frame = this.currentFrame
    this.clock.set(Date.parse(this.scenario.fixtureNow) + frame.offsetMs)
    this.publish()
  }

  nextFrame(): void {
    this.selectFrame(this.frameIndex + 1)
  }

  prevFrame(): void {
    this.selectFrame(this.frameIndex - 1)
  }

  play(): void {
    if (this.playing) return
    if (this.frameIndex >= this.scenario.frames.length - 1) {
      this.frameIndex = 0
      this.clock.set(Date.parse(this.scenario.fixtureNow))
    }
    this.playing = true
    this.lastTickWall = Date.now()
    this.timer = setInterval(() => this.tick(), TICK_MS)
    this.publish()
  }

  pause(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (this.playing) {
      this.playing = false
      this.publish()
    }
  }

  reset(): void {
    this.pause()
    this.frameIndex = 0
    this.refreshCount = 0
    this.clock.set(Date.parse(this.scenario.fixtureNow))
    this.publish()
  }

  /** 重新读取同一帧：不切换场景、不新建任务、不推进轮次 */
  refresh(): void {
    this.refreshCount += 1
    this.publish()
  }

  /** 演示时钟推进；到达下一帧偏移就切换帧（可跨越多帧） */
  advance(elapsedMs: number): void {
    if (elapsedMs <= 0) return
    this.clock.advance(elapsedMs)
    this.lastTickWall = Date.now()
    const elapsed = this.clock.timeMs - Date.parse(this.scenario.fixtureNow)
    let index = this.frameIndex
    while (index + 1 < this.scenario.frames.length) {
      const next = this.scenario.frames[index + 1]!
      if (elapsed < next.offsetMs) break
      index += 1
    }
    if (index !== this.frameIndex) {
      this.frameIndex = index
      if (this.frameIndex >= this.scenario.frames.length - 1) {
        this.playing = false
        if (this.timer !== null) {
          clearInterval(this.timer)
          this.timer = null
        }
      }
    }
    this.publish()
  }

  tick(): void {
    this.advance(TICK_MS)
  }

  /**
   * 页签从后台恢复时按真实经过时间补齐演示时钟，
   * 避免后台节流让倒计时停在旧值；不会延长任何 deadline。
   */
  resumeVisible(): void {
    if (!this.playing) return
    const elapsed = Date.now() - this.lastTickWall
    if (elapsed > TICK_MS * 2) {
      this.advance(elapsed)
    } else {
      this.lastTickWall = Date.now()
    }
  }

  dispose(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.listeners.clear()
  }
}
