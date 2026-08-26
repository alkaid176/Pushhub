/**
 * SeqDedup —— seq 幂等去重窗口（02-01，D-17）。
 *
 * 职责：SDK 内部维护 last_seq + 已见 seq 集合，实时帧与补拉帧交叠时自动去重，
 * 宿主回调永不见重复消息——服务端承诺零丢失零重复（SC2），SDK 是第二道防线
 * （防部署断连窗口的边界交叠：服务端每次 accept 无条件重推最近 50 条首拉）。
 *
 * 内存有界：窗口按 DEDUP_WINDOW 裁剪——服务端保留窗口 RETENTION_KEEP=500 +
 * 首拉 INITIAL_FETCH=50 的交叠上界 ~550，取 1000 留冗余（A2 建议值）。
 */

/** 去重窗口宽度：lastSeq - DEDUP_WINDOW 之前的旧 seq 从 Set 裁剪。 */
export const DEDUP_WINDOW = 1000;

export class SeqDedup {
  private readonly seen = new Set<number>();
  private lastSeq = 0;

  /**
   * 该 seq 是否应投递给宿主。
   *  - 已见 → false（重复，不投递）；
   *  - 未见 → 记录、lastSeq 取 max、裁剪超窗口旧条目 → true。
   */
  shouldDeliver(seq: number): boolean {
    if (this.seen.has(seq)) return false;
    this.seen.add(seq);
    if (seq > this.lastSeq) this.lastSeq = seq;
    const floor = this.lastSeq - DEDUP_WINDOW;
    if (this.seen.size > DEDUP_WINDOW) {
      for (const s of this.seen) {
        if (s < floor) this.seen.delete(s);
      }
    }
    return true;
  }

  /** 当前游标（已见最大 seq；空窗口为 0）。 */
  get last(): number {
    return this.lastSeq;
  }

  /** 测试观测口：当前去重窗口内存条目数（有界性断言用）。 */
  get size(): number {
    return this.seen.size;
  }
}
