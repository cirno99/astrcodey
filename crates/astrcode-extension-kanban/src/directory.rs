//! 文件夹选择器使用的目录列举。
//!
//! 浏览器的文件夹选择器只能给出文件夹名，给不出本机绝对路径，因此这件事只能由服务端
//! 代劳：只列一层目录、不读文件内容，返回给前端的只有目录名与路径。

use std::path::{Path, PathBuf};

use serde::Serialize;

/// 单层列举的目录数上限。
///
/// 在主目录或 `/nix/store` 这类地方一次列出几万条既没必要也拖慢弹窗；截断后由
/// `truncated` 告诉前端列表不完整，用户仍然可以手输路径。
const MAX_DIRECTORY_ENTRIES: usize = 500;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryEntry {
    pub name: String,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryListing {
    /// 实际列举的目录路径，已去掉首尾空白。
    pub path: String,
    /// 上级目录；已经是根目录时为 `None`。
    pub parent: Option<String>,
    pub entries: Vec<DirectoryEntry>,
    /// 是否因为条目上限而截断。
    pub truncated: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum DirectoryError {
    #[error("需要绝对路径: {0}")]
    NotAbsolute(String),
    #[error("目录不存在: {0}")]
    NotFound(String),
    #[error("不是目录: {0}")]
    NotADirectory(String),
    #[error("读取目录失败: {0}")]
    Io(#[from] std::io::Error),
}

/// 列举 `path` 下的一层子目录。
///
/// 路径为空时从进程当前目录开始，这样用户第一次打开选择器总有个落脚点。
/// 路径原样回显、不做规范化：`canonicalize` 在 Windows 上会返回 `\\?\C:\...` 形式的
/// UNC 路径，用户看到的、卡片里存的都会变成这个写法。
pub fn list_directories(path: &str) -> Result<DirectoryListing, DirectoryError> {
    let trimmed = path.trim();
    let directory = if trimmed.is_empty() {
        std::env::current_dir()?
    } else {
        PathBuf::from(trimmed)
    };

    if !directory.is_absolute() {
        return Err(DirectoryError::NotAbsolute(
            directory.to_string_lossy().into_owned(),
        ));
    }
    ensure_directory(&directory)?;

    let mut entries = Vec::new();
    for entry in std::fs::read_dir(&directory)? {
        let entry = entry?;
        // 符号链接指向目录时也算目录：工作区经常是链接。取不到元数据的条目（断链、
        // 权限不足）跳过而不是让整次列举失败——一个坏条目不该毁掉整个选择器。
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if !metadata.is_dir() {
            continue;
        }
        entries.push(DirectoryEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            path: entry.path().to_string_lossy().into_owned(),
        });
    }

    entries.sort_by(|left, right| {
        left.name
            .to_lowercase()
            .cmp(&right.name.to_lowercase())
            .then_with(|| left.name.cmp(&right.name))
    });
    let truncated = entries.len() > MAX_DIRECTORY_ENTRIES;
    entries.truncate(MAX_DIRECTORY_ENTRIES);

    Ok(DirectoryListing {
        parent: directory
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .map(|parent| parent.to_string_lossy().into_owned()),
        path: directory.to_string_lossy().into_owned(),
        entries,
        truncated,
    })
}

/// 确认路径存在且确实是目录；文件与不存在的路径要给出不同的错误。
fn ensure_directory(directory: &Path) -> Result<(), DirectoryError> {
    let display = directory.to_string_lossy().into_owned();
    match std::fs::metadata(directory) {
        Ok(metadata) if metadata.is_dir() => Ok(()),
        Ok(_) => Err(DirectoryError::NotADirectory(display)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Err(DirectoryError::NotFound(display))
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotADirectory => {
            Err(DirectoryError::NotADirectory(display))
        },
        Err(error) => Err(DirectoryError::Io(error)),
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    #[test]
    fn lists_only_directories_sorted_by_name() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("zeta")).unwrap();
        fs::create_dir(root.path().join("Alpha")).unwrap();
        fs::write(root.path().join("note.txt"), b"x").unwrap();

        let listing = list_directories(&root.path().to_string_lossy()).unwrap();

        assert_eq!(
            listing
                .entries
                .iter()
                .map(|entry| entry.name.as_str())
                .collect::<Vec<_>>(),
            vec!["Alpha", "zeta"]
        );
        assert_eq!(
            listing.entries[0].path,
            root.path().join("Alpha").to_string_lossy()
        );
        assert_eq!(listing.path, root.path().to_string_lossy());
        let expected_parent = root.path().parent().unwrap().to_string_lossy().into_owned();
        assert_eq!(listing.parent.as_deref(), Some(expected_parent.as_str()));
        assert!(!listing.truncated);
    }

    #[test]
    fn empty_path_falls_back_to_the_current_directory() {
        let listing = list_directories("   ").unwrap();
        assert_eq!(
            listing.path,
            std::env::current_dir().unwrap().to_string_lossy()
        );
    }

    #[test]
    fn relative_paths_are_rejected() {
        assert!(matches!(
            list_directories("relative/dir"),
            Err(DirectoryError::NotAbsolute(_))
        ));
    }

    #[test]
    fn missing_path_and_file_paths_are_distinguished() {
        let root = tempfile::tempdir().unwrap();
        let missing = root.path().join("missing");
        assert!(matches!(
            list_directories(&missing.to_string_lossy()),
            Err(DirectoryError::NotFound(_))
        ));

        let file = root.path().join("note.txt");
        fs::write(&file, b"x").unwrap();
        assert!(matches!(
            list_directories(&file.to_string_lossy()),
            Err(DirectoryError::NotADirectory(_))
        ));
    }

    #[test]
    fn root_directory_has_no_parent() {
        let root = list_directories("/").unwrap();
        assert_eq!(root.parent, None);
        // 前端解码器按 camelCase 读 `parent`，根目录也要显式给出 null 而不是缺字段。
        let value = serde_json::to_value(&root).unwrap();
        assert!(value.get("parent").is_some());
        assert!(value["parent"].is_null());
    }

    #[test]
    fn listing_serializes_with_the_camel_case_wire_shape() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("alpha")).unwrap();

        let listing = list_directories(&root.path().to_string_lossy()).unwrap();
        let value = serde_json::to_value(&listing).unwrap();

        assert_eq!(value["path"], listing.path);
        assert_eq!(value["parent"], serde_json::json!(listing.parent));
        assert_eq!(value["truncated"], false);
        assert_eq!(value["entries"][0]["name"], "alpha");
        assert_eq!(
            value["entries"][0]["path"],
            root.path().join("alpha").to_string_lossy().as_ref()
        );
    }

    #[test]
    fn entry_limit_truncates_the_listing() {
        let root = tempfile::tempdir().unwrap();
        for index in 0..MAX_DIRECTORY_ENTRIES + 1 {
            fs::create_dir(root.path().join(format!("dir-{index:04}"))).unwrap();
        }

        let listing = list_directories(&root.path().to_string_lossy()).unwrap();

        assert!(listing.truncated);
        assert_eq!(listing.entries.len(), MAX_DIRECTORY_ENTRIES);
    }
}
