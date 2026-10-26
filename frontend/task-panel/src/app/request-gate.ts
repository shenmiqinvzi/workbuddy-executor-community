/**
 * 请求归属判断：只认"最近一次选择"，不比较 revision 字符串的新旧。
 */
export class RequestGate {
  private generation = 0

  next(): number {
    this.generation += 1
    return this.generation
  }

  isCurrent(generation: number): boolean {
    return generation === this.generation
  }
}
