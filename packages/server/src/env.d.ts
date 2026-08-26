/**
 * Env 声明合并补充（worker-configuration.d.ts 由 wrangler types 生成，只含
 * wrangler.jsonc 声明的 bindings）：ADMIN_KEY 是 Worker secret（01-01 经
 * wrangler secret put 写入），不在配置文件中、无法自动生成，类型在此手写。
 *
 * secret 未配置时运行时为 undefined——/api/admin/* 据此返回 500 server_error
 * （Flagged Assumption KEY-01），故显式类型为 string | undefined。
 */
interface Env {
  ADMIN_KEY: string | undefined;
}
