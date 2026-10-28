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
    /// 光标的运行时绝对路径；`theme.json` 里落盘的是相对主题目录的路径
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

/// 一套主题的文件缺口：声明了的槽位里，哪些文件已经读不到
///
/// 只描述事实，不带建议——怎么处理（重新导入 / 删除）由界面按主题状态说。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThemeFileGap {
    pub theme_id: String,
    /// 缺失或不可读槽位的注册表键名，保持主题内声明顺序
    pub slots: Vec<String>,
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
    /// 注册表当前非空槽位数（只统计 15 个标准槽位）
    ///
    /// 用于区分 `active_theme_id = None` 的两种成因：0 = 系统默认，
    /// 大于 0 = 槽位有值但不属于任何已知主题（被系统设置或其它工具改写）。
    pub current_slots_filled: usize,
    /// 槽位非空但匹配不到任何主题：光标被系统设置 / 其它工具改写
    ///
    /// 2026-10-26 真机实验结论：系统「鼠标指针样式」设置页会整体改写 15 个
    /// 经典槽位（如选黑色写入 `%SystemRoot%\cursors\*_r.cur`），本应用不重查
    /// 就会带着旧的「正在使用」状态骗人。前端据此在状态卡上给出警示。
    pub active_external: bool,
    /// **最近主题**（不是原始事件流）：同一主题只留最新一条，最多 50 个，最新在前
    pub recent: Vec<HistoryEntry>,
    /// 文件缺口清单（决策 31）：声明了的槽位文件读不到的主题
    ///
    /// 只列有缺口的主题；`theme.json` 不落这个字段——它每次读列表时现算，
    /// 文件恢复后缺口自动消失。`#[serde(default)]` 兜住「前端旧、Rust 新」的
    /// 热更新组合，别的时候当普通字段用。
    #[serde(default)]
    pub file_gaps: Vec<ThemeFileGap>,
}

/// `get_active_state` 的返回值：窗口聚焦时轻量重查「当前使用」
///
/// 只重读注册表与主题清单做比对，不重读历史、不动界面其余状态——
/// 聚焦很频繁，别把整个 `get_all_themes` 的成本都压上去。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActiveState {
    /// 注册表里当前生效的主题 ID；`None` = 系统默认或被外部改写
    pub active_theme_id: Option<String>,
    /// 注册表当前非空槽位数（只统计 15 个标准槽位）
    pub current_slots_filled: usize,
    /// 槽位非空但匹配不到任何主题（被系统设置 / 其它工具改写）
    pub active_external: bool,
}

/// 一条历史事件（每次应用主题产生一条，不去重）
///
/// 磁盘上的 `history.json` 存事件流；界面拿到的 `recent` 由它派生。
/// 只存应用当时的名称快照，不存整份主题：主题随时可能被改名或删除，
/// 历史要能独立成立，不能因为主题没了就整条消失。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryEntry {
    /// 系统方案为 `sys_<方案名>`，用户主题为 UUID
    pub theme_id: String,
    /// 应用时的显示名
    pub name: String,
    pub is_built_in: bool,
    /// 应用时间，本地时区，格式 `%Y-%m-%d %H:%M`
    pub applied_at: String,
}

/// `apply_theme` 的返回值
///
/// 光标切换是主操作，记历史是附属操作：历史写失败时主题照样算应用成功，
/// 但必须把原因带回去，不能静默当作记上了。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApplyOutcome {
    /// 记录之后派生出的最近主题，最新在前（按主题去重）
    pub recent: Vec<HistoryEntry>,
    /// 光标已切换、但历史没记上时的原因；正常为 `None`
    pub warning: Option<String>,
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
