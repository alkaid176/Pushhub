/**
 * 状态机测试共享帧构造器（02-02）。
 *
 * 机器测试直接构造 FrameResult.ok:true 的 ServerFrame（绕过 parseServerFrame，
 * 后者的契约由 frames.test.ts 吃 golden fixtures 独立锁定）——本文件只提供
 * 最小合法 13 字段 message 帧与 history 帧工厂。
 */
import type { HistoryFrame, MessageFrame } from "@pushhub/shared";

/** 最小合法 message 帧（D-03 冻结 13 字段；可选字段走省略语义）。 */
export function msgFrame(seq: number, overrides: Partial<MessageFrame> = {}): MessageFrame {
  return {
    v: 1,
    type: "message",
    wid: `m_test${String(seq).padStart(12, "0")}`,
    seq,
    text: `message #${seq}`,
    priority: "normal",
    answered: false,
    answered_by: null,
    answered_at: null,
    answered_content: null,
    created_at: 1_700_000_000_000 + seq,
    ...overrides,
  };
}

/** history 帧工厂（oldest_kept_seq / has_more 原样字段由调用方指定）。 */
export function historyFrame(
  messages: MessageFrame[],
  oldest_kept_seq: number,
  has_more: boolean,
): HistoryFrame {
  return { v: 1, type: "history", messages, oldest_kept_seq, has_more };
}
