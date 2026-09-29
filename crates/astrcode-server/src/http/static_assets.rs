//! 内嵌的前端静态资源。
//!
//! 产物目录由 `build.rs` 保证存在：前端未构建时写入占位页，因此 derive 不会因为
//! 缺少 `frontend/dist` 而编译失败。

use axum::{
    body::Body,
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};

/// 与 `assets/frontend-placeholder.html`、`build.rs` 是同一份内容，用于识别占位页。
const PLACEHOLDER_INDEX_HTML: &str = include_str!("../../assets/frontend-placeholder.html");

const INDEX_HTML_PATH: &str = "index.html";
/// Vite 产出的带内容哈希目录，内容随文件名变化，可以长期强缓存。
const HASHED_ASSET_PREFIX: &str = "assets/";
const IMMUTABLE_CACHE_CONTROL: &str = "public, max-age=31536000, immutable";
const NO_CACHE_CONTROL: &str = "no-cache";

#[derive(rust_embed::RustEmbed)]
#[folder = "../../frontend/dist"]
struct FrontendAssets;

/// 内嵌产物是否为 `build.rs` 写入的占位页。
pub(in crate::http) fn is_placeholder() -> bool {
    FrontendAssets::get(INDEX_HTML_PATH)
        .is_some_and(|file| file.data.as_ref() == PLACEHOLDER_INDEX_HTML.as_bytes())
}

/// 返回内嵌产物；路径不存在时返回 `None`，由调用方决定兜底语义。
///
/// `rust_embed` 的 `get` 是对内嵌键的精确查找，不经过文件系统，因此不存在路径穿越。
pub(in crate::http) fn serve(path: &str) -> Option<Response> {
    let path = normalize(path)?;
    let file = FrontendAssets::get(path)?;

    let cache_control = if path.starts_with(HASHED_ASSET_PREFIX) {
        IMMUTABLE_CACHE_CONTROL
    } else {
        NO_CACHE_CONTROL
    };
    Some(
        (
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, file.metadata.mimetype().to_owned()),
                (header::CACHE_CONTROL, cache_control.to_owned()),
            ],
            Body::from(file.data.into_owned()),
        )
            .into_response(),
    )
}

/// `/` 映射到 `index.html`；其余路径去掉前导 `/` 后按内嵌键查找。
fn normalize(path: &str) -> Option<&str> {
    let path = path.trim_start_matches('/');
    if path.is_empty() {
        return Some(INDEX_HTML_PATH);
    }
    // 目录请求（`/assets/`）没有对应的内嵌条目。
    if path.ends_with('/') {
        return None;
    }
    Some(path)
}

#[cfg(test)]
mod tests {
    use super::{INDEX_HTML_PATH, normalize};

    #[test]
    fn root_maps_to_index_and_directory_paths_are_rejected() {
        assert_eq!(normalize("/"), Some(INDEX_HTML_PATH));
        assert_eq!(normalize(""), Some(INDEX_HTML_PATH));
        assert_eq!(
            normalize("/assets/index-abc.js"),
            Some("assets/index-abc.js")
        );
        assert_eq!(normalize("/assets/"), None);
    }
}
