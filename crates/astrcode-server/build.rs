//! 保证 `frontend/dist` 在编译期存在，供 `static_assets` 内嵌。
//!
//! 前端产物不入库（见仓库根 `.gitignore`），全新检出时该目录不存在。这里写入
//! 占位页而不是让编译失败，使未构建前端的构建仍然可用；占位页由服务端在启动时
//! 识别并告警。

use std::{env, fs, path::PathBuf};

/// 与 `src/http/static_assets.rs` 内嵌的是同一份文件，后者据此识别占位页。
const PLACEHOLDER_INDEX_HTML: &str = include_str!("assets/frontend-placeholder.html");

fn main() {
    let manifest_dir =
        PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("cargo 会注入 CARGO_MANIFEST_DIR"));
    let dist = manifest_dir.join("../../frontend/dist");

    // 内嵌发生在 rustc 展开 derive 时，cargo 无从得知产物已变化，必须显式声明依赖。
    println!("cargo:rerun-if-changed={}", dist.display());

    let index = dist.join("index.html");
    if index.exists() {
        return;
    }

    fs::create_dir_all(&dist)
        .and_then(|()| fs::write(&index, PLACEHOLDER_INDEX_HTML))
        .unwrap_or_else(|error| panic!("写入前端占位页 {} 失败: {error}", index.display()));

    println!(
        "cargo:warning=frontend/dist 不存在，已写入占位页；运行 `cd frontend && npm run build` \
         生成真实前端。"
    );
}
