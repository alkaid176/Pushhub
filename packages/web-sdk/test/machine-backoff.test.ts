/**
 * 纯状态机退避单测（02-02 Task 1，SC2/WEB-04）。
 *
 * full jitter：delay = random() * min(60_000, 500 * 2^attempt)。
 * 随机数经 createMachine({ random }) 注入——测试确定性（模块纯逻辑要求，
 * Phase 5 Tauri 移植同构参考）。
 *
 * 场景：连续 30 次连接失败（WS_CLOSE 落在 connecting 态，未及 WS_OPEN）→
 * attempt 0..29 递增 → 全部 schedule(reconnect).delayMs 落在
 * [0, min(60_000, 500*2^attempt)] 区间，且 cap 恰为 60_000（SC2 锁定值）。
 */
import { describe, it, expect } from "vitest";
import {
  createMachine,
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  type MachineAction,
} from "../src/connection-machine";

function reconnectDelays(actions: MachineAction[]): number[] {
  return actions
    .filter(
      (a): a is Extract<MachineAction, { kind: "schedule" }> =>
        a.kind === "schedule" && a.timer === "reconnect",
    )
    .map((a) => a.delayMs);
}

/** 连接失败循环：CONNECT → (WS_CLOSE → TIMER(reconnect)) × 30，attempt 0..29。 */
function collectBackoff(random: () => number): number[] {
  const m = createMachine({ random });
  m.input({ kind: "CONNECT" });
  const delays: number[] = [];
  for (let i = 0; i < 30; i++) {
    delays.push(...reconnectDelays(m.input({ kind: "WS_CLOSE" })));
    m.input({ kind: "TIMER", timer: "reconnect" }); // 触发退避定时器 → 重试连接
  }
  return delays;
}

describe("full jitter 退避（SC2 cap 60s 锁定）", () => {
  it("常量锁定：base 500ms / cap 60_000ms", () => {
    expect(BACKOFF_BASE_MS).toBe(500);
    expect(BACKOFF_CAP_MS).toBe(60_000);
  });

  it("连续 30 次重连尝试：每个 delay ∈ [0, min(60_000, 500*2^attempt)]（多组随机样本）", () => {
    const samples: Array<() => number> = [
      () => 0,
      () => 0.5,
      () => 0.25,
      () => 0.75,
      () => 0.999999999999,
      () => 0.000001,
    ];
    for (const random of samples) {
      const delays = collectBackoff(random);
      expect(delays.length).toBe(30);
      delays.forEach((delay, attempt) => {
        const bound = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThanOrEqual(bound);
      });
    }
  });

  it("full jitter 确定值：random=0.5 → delay = min(cap, base*2^attempt) * 0.5", () => {
    const delays = collectBackoff(() => 0.5);
    delays.forEach((delay, attempt) => {
      expect(delay).toBe(
        Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt) * 0.5,
      );
    });
  });

  it("cap 恰为 60_000：random=1 时 attempt≥7 的 delay 精确等于 60_000", () => {
    const delays = collectBackoff(() => 1);
    delays.forEach((delay, attempt) => {
      if (attempt >= 7) {
        // 500*2^7 = 64_000 > 60_000 → min 生效，上限精确锁在 60_000。
        expect(delay).toBe(60_000);
      } else {
        expect(delay).toBe(BACKOFF_BASE_MS * 2 ** attempt);
      }
    });
  });

  it("random=0 时 delay=0（full jitter 下界闭区间）", () => {
    for (const delay of collectBackoff(() => 0)) {
      expect(delay).toBe(0);
    }
  });

  it("成功连接（WS_OPEN）后 attempt 归零——再断连退避回到 base 档", () => {
    const m = createMachine({ random: () => 0.5 });
    m.input({ kind: "CONNECT" });
    for (let i = 0; i < 3; i++) {
      m.input({ kind: "WS_CLOSE" });
      m.input({ kind: "TIMER", timer: "reconnect" });
    }
    m.input({ kind: "WS_OPEN" }); // 第四次尝试成功 → attempt 归零
    const acts = m.input({ kind: "WS_CLOSE" });
    expect(reconnectDelays(acts)[0]).toBe(250); // 0.5 * 500
  });
});
