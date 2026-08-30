package app.pushhub.android.machine

/**
 * SeqDedup —— seq 幂等去重窗口（06-01 Task 3，D-17）。
 *
 * packages/web-sdk/src/dedup.ts:13-46 逐行为对齐（第三端同构移植）：
 * 实时帧与补拉帧交叠时自动去重，宿主回调永不见重复消息——服务端承诺零丢失零重复，
 * 客户端是第二道防线（部署断连窗口的边界交叠：服务端每次 accept 无条件重推最近
 * 50 条首拉）。
 *
 * 内存有界：窗口按 DEDUP_WINDOW 裁剪——服务端保留窗口 RETENTION_KEEP=500 +
 * 首拉 INITIAL_FETCH=50 的交叠上界 ~550，取 1000 留冗余（02-01 A2 建议值）。
 */

/** 去重窗口宽度：lastSeq - DEDUP_WINDOW 之前的旧 seq 从 Set 裁剪。 */
const val DEDUP_WINDOW: Long = 1000

class SeqDedup {
    private val seen = mutableSetOf<Long>()
    private var lastSeq = 0L

    /**
     * 该 seq 是否应投递给宿主。
     *  - 已见 → false（重复，不投递）；
     *  - 未见 → 记录、lastSeq 取 max、裁剪超窗口旧条目 → true。
     */
    fun shouldDeliver(seq: Long): Boolean {
        if (!seen.add(seq)) return false
        if (seq > lastSeq) lastSeq = seq
        val floor = lastSeq - DEDUP_WINDOW
        if (seen.size > DEDUP_WINDOW) {
            seen.removeIf { it < floor }
        }
        return true
    }

    /** 当前游标（已见最大 seq；空窗口为 0）。 */
    val last: Long
        get() = lastSeq

    /** 测试观测口：当前去重窗口内存条目数（有界性断言用）。 */
    val size: Int
        get() = seen.size
}
