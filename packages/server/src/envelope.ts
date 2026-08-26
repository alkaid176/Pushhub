/**
 * D-06 错误信封唯一实现（index.ts 与 admin.ts 共用）。
 *
 * 信封形态是对外冻结契约（发送方脚本程序化消费 code）：`{"error":{"code","message"}}`，
 * 两处各写一份必然漂移——收敛到单点。message 为通用文案，不含堆栈与内部键名。
 */
export function errorEnvelope(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
