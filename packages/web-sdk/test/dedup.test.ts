/**
 * SeqDedup 去重窗口测试（02-01，D-17）。
 *
 * 覆盖：首次投递 true、重复 seq false、乱序到达 lastSeq 取 max、
 * 超窗口旧 seq 裁剪后 Set 尺寸有界（内存不随消息量无界增长）。
 */
import { describe, it, expect } from "vitest";
import { SeqDedup, DEDUP_WINDOW } from "../src/dedup";

describe("SeqDedup（D-17 宿主永见重复）", () => {
  it("首次 seq 投递 true，重复 seq false", () => {
    const d = new SeqDedup();
    expect(d.shouldDeliver(1)).toBe(true);
    expect(d.shouldDeliver(1)).toBe(false);
    expect(d.shouldDeliver(2)).toBe(true);
    expect(d.shouldDeliver(2)).toBe(false);
    expect(d.shouldDeliver(1)).toBe(false);
  });

  it("乱序到达 lastSeq 取 max", () => {
    const d = new SeqDedup();
    expect(d.shouldDeliver(10)).toBe(true);
    expect(d.last).toBe(10);
    expect(d.shouldDeliver(5)).toBe(true);
    expect(d.last).toBe(10);
    expect(d.shouldDeliver(3)).toBe(true);
    expect(d.last).toBe(10);
    expect(d.shouldDeliver(12)).toBe(true);
    expect(d.last).toBe(12);
  });

  it("超窗口旧 seq 被裁剪后 Set 尺寸有界", () => {
    const d = new SeqDedup();
    for (let seq = 1; seq <= 3000; seq++) {
      d.shouldDeliver(seq);
    }
    // 连续投递 3000 条后：窗口内只保留 [lastSeq-DEDUP_WINDOW, lastSeq] 一带。
    expect(d.size).toBeLessThanOrEqual(DEDUP_WINDOW + 1);
    expect(d.last).toBe(3000);
  });

  it("窗口内重复仍被拦（裁剪不影响近期去重）", () => {
    const d = new SeqDedup();
    for (let seq = 1; seq <= 2000; seq++) {
      d.shouldDeliver(seq);
    }
    // seq 1500 在窗口 [1000, 2000] 内——重复拦截。
    expect(d.shouldDeliver(1500)).toBe(false);
    expect(d.shouldDeliver(2000)).toBe(false);
    expect(d.shouldDeliver(2001)).toBe(true);
  });

  it("实时帧与补拉帧交叠（重连场景）：已见消息不二次投递", () => {
    const d = new SeqDedup();
    // 断线前见 1..30（实时）。
    for (let seq = 1; seq <= 30; seq++) expect(d.shouldDeliver(seq)).toBe(true);
    // 断线期间 31..100 到达；重连首拉返回最近 50（51..100）。
    for (let seq = 51; seq <= 100; seq++) expect(d.shouldDeliver(seq)).toBe(true);
    // sync 补拉返回 31..100（全量 > 旧游标）——31..50 首见投递，51..100 重复拦截。
    let delivered = 0;
    for (let seq = 31; seq <= 100; seq++) {
      if (d.shouldDeliver(seq)) delivered++;
    }
    expect(delivered).toBe(20);
    expect(d.last).toBe(100);
  });
});
