use serde::{Deserialize, Serialize};

/// 一个光标槽位，对应注册表 `Control Panel\Cursors` 下的一个值
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CursorSlot {
    /// 注册表键名，如 `Arrow`、`SizeNWSE`
    pub registry_key: String,
    /// 中文名，如「正常选择」
    pub display_name: String,
    /// 英文名，如 `Normal Select`
    pub english_name: String,
    /// 光标文件绝对路径
    pub file_path: String,
    /// 文件类型：`cur` 或 `ani`
    pub file_type: String,
}

/// 一套光标主题
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CursorTheme {
    /// 系统方案为 `sys_<方案名>`，用户主题为 UUID
    pub id: String,
    pub name: String,
    pub description: String,
    pub created_at: String,
    pub updated_at: String,
    /// 是否为系统注册表里的方案
    pub is_built_in: bool,
    pub cursors: Vec<CursorSlot>,
}

/// `get_all_themes` 的返回值：能读到多少给多少，失败项进 `warnings`
///
/// 系统方案（注册表）与用户主题（磁盘）是两个独立来源。以前任何一边出错
/// 都走 `Result::Err` 把整锅端掉，本来能显示的用户主题跟着一起消失。现在
/// 各来源独立降级，错误改走 `warnings` 通道，只有聚合本身失败才返回 `Err`。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThemesResult {
    /// 能读出来的主题（系统方案 + 用户主题）
    pub themes: Vec<CursorTheme>,
    /// 非致命问题的中文描述，供界面提示"哪些数据没能加载"
    pub warnings: Vec<String>,
    /// 注册表里当前生效的主题 ID
    ///
    /// 由「注册表当前光标路径」与各主题的槽位路径比对得出，而不是界面自己记。
    /// `None` 表示识别不出：既可能是系统默认光标，也可能是用户手工改过设置。
    pub active_theme_id: Option<String>,
}

/// 光标文件预览数据
///
/// `image` / `frames` 为 PNG 的 base64 字符串（不含 `data:` 前缀）。
/// 解析失败时全部为空，`is_animated` 为 false。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CursorPreview {
    /// 是否为多帧动态光标
    pub is_animated: bool,
    /// 首帧静态图，静态光标即唯一一帧
    pub image: String,
    /// 全部帧（仅动态光标多于一项）
    pub frames: Vec<String>,
    /// 动画帧间隔（毫秒），静态光标为 0
    pub rate_ms: u32,
    /// 热点坐标 (x, y)
    pub hotspot: (u32, u32),
}
