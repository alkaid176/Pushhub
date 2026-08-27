# Phase 02 Deferred Items

范围外发现（executor 范围边界规则登记——不在当前计划内修复）。

## 1. `.claude/admin.key` 未跟踪密钥文件无 gitignore 防护

- **发现于:** 02-06 Task 2（git status 核查时）
- **事项:** `.claude/admin.key`（64 字节，生产 ADMIN_KEY 明文）为用户本地放置的冒烟密钥文件，目前仅靠"未被 add"保安全——`.gitignore` 覆盖 `.dev.vars` 但不含 `.claude/admin.key`，一次误操作 `git add .`/`git add -A` 即可泄露进历史
- **建议:** 在 `.gitignore` 增补 `.claude/admin.key`（或移出仓库目录）；属仓库卫生变更，建议归下一个计划或 /gsd-quick 处理
- **状态:** open
