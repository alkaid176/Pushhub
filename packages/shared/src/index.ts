/**
 * @pushhub/shared — 四端线协议唯一事实源（最小切片版）
 *
 * 本文件当前只包含 01-01 walking skeleton 用到的最小集合；
 * 完整字段集（options / callback_url / click_url / answered_*、
 * sync / history / error 帧、上限常量、golden fixtures）由 01-02 冻结。
 *
 * D-07 协议演进规则（冻结后生效）：
 *  - 所有 WS 帧顶层带 v:1（整数递增）
 *  - 只加字段不改语义；未知字段必须忽略（Rust serde 禁用 deny_unknown_fields）
 *  - 客户端不识别的 v 即断连报错
 */

/** 线协议版本（D-07）：所有 WS 帧顶层 `v` 字段的当前值。 */
export const PROTOCOL_VERSION = 1;

/** 消息优先级三档枚举（D-04）。 */
export type Priority = "low" | "normal" | "high";

/**
 * v:1 message 帧（最小集，D-05/D-07）。
 * wid：对外消息 ID（m_ + 16 字符，URL 安全不可猜测）；
 * seq：频道内单调游标（补拉与幂等去重的依据）。
 */
export interface MessageFrame {
  v: typeof PROTOCOL_VERSION;
  wid: string;
  seq: number;
  title?: string;
  text: string;
  priority: Priority;
}
