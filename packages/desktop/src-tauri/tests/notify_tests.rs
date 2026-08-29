//! notify 模块测试载体（05-03 Task 3）。
//!
//! lib.rs 的模块声明归 05-04 波次所有（协调并行约束，本波不编辑 lib.rs），
//! 本文件经 `#[path]` 把 `src/notify/` 编入独立集成测试目标——notify 的
//! 单元测试（`notify::tests` / `notify::summary::tests`）无需 lib.rs 接线
//! 即可被 `cargo test notify::` 运行。
//!
//! 05-05 在 lib.rs 添加 `mod notify;` 后，本文件可移除（届时单元测试随
//! lib 目标运行，测试名与过滤条件不变）。

#[path = "../src/notify/mod.rs"]
mod notify;
