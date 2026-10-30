/** 与 Rust 端 `models::CursorSlot` 字段一一对应 */
export interface CursorSlot {
  registry_key: string;
  display_name: string;
  english_name: string;
  /** 运行时绝对路径；落盘到 theme.json 时只存相对主题目录的路径 */
  file_path: string;
  file_type: string;
}

/** 与 Rust 端 `models::CursorTheme` 字段一一对应 */
export interface CursorTheme {
  id: string;
  name: string;
  description: string;
  created_at: string;
  updated_at: string;
  is_built_in: boolean;
  cursors: CursorSlot[];
}

/** 与 Rust 端 `importer::ImportReport` 字段一一对应 */
export interface ImportReport {
  theme: CursorTheme;
  /** 导入成功但被跳过的内容（典型：链接 / 目录联接） */
  warnings: string[];
  /** 与库里哪套主题内容完全相同（决策 47，只提示不拦截）；没有重复为 null */
  duplicate_of: string | null;
}

/**
 * 与 Rust 端 `models::HistoryEntry` 字段一一对应
 *
 * 后端磁盘存的是**事件流**（每次应用一条）；界面拿到的 `recent` 是派生后的
 * **最近主题**（同主题只留最新一条）。这里只描述一条记录本身。
 */
export interface HistoryEntry {
  /** 系统方案为 `sys_<方案名>`，用户主题为 UUID */
  theme_id: string;
  /** 应用时的显示名快照：主题被删掉后仍能说清「上次用的是哪个」 */
  name: string;
  is_built_in: boolean;
  /** 本地时区，格式 `YYYY-MM-DD HH:mm` */
  applied_at: string;
}

/**
 * 一套主题的文件缺口：声明了的槽位里，哪些文件已经读不到（决策 31）
 *
 * 后端每次读列表时现算（只 stat 不读内容）；`theme.json` 不落这个字段，
 * 文件恢复后缺口自动消失。
 */
export interface ThemeFileGap {
  theme_id: string;
  /** 缺失或不可读槽位的注册表键名，保持主题内声明顺序 */
  slots: string[];
}

/** 与 Rust 端 `models::ThemesResult` 字段一一对应 */
export interface ThemesResult {
  /** 能读到的主题（系统方案 + 用户主题），部分来源失败时仍返回其余部分 */
  themes: CursorTheme[];
  /** 非致命问题的中文描述，对应没能加载的数据源 */
  warnings: string[];
  /**
   * 注册表里当前生效的主题 ID，由后端比对光标路径得出
   *
   * null = 识别不出（系统默认光标，或用户手工改过设置）。
   * 不要指望从本地存储恢复它：重启后注册表才是事实来源。
   */
  active_theme_id: string | null;
  /** 注册表当前非空槽位数（只统计 15 个标准槽位）；0 = 系统默认 */
  current_slots_filled: number;
  /** 槽位非空但匹配不到任何主题：被系统设置或其它工具改写（决策 24） */
  active_external: boolean;
  /** 最近主题（由后端事件流派生，按主题去重），最新在前 */
  recent: HistoryEntry[];
  /**
   * 文件缺口清单（决策 31）：声明了的槽位文件读不到的主题
   *
   * 只列有缺口的主题；「前端旧、Rust 新」的组合里可能是 undefined，读时兜底 `?? []`。
   */
  file_gaps: ThemeFileGap[];
}

/** 与 Rust 端 `models::ActiveState` 字段一一对应（`get_active_state`） */
export interface ActiveState {
  /** 注册表里当前生效的主题 ID；null = 系统默认或被外部改写 */
  active_theme_id: string | null;
  /** 注册表当前非空槽位数（只统计 15 个标准槽位） */
  current_slots_filled: number;
  /** 槽位非空但匹配不到任何主题（被系统设置 / 其它工具改写） */
  active_external: boolean;
}

/** 与 Rust 端 `models::ApplyOutcome` 字段一一对应 */
export interface ApplyOutcome {
  /** 记录之后派生出的最近主题（按主题去重），最新在前 */
  recent: HistoryEntry[];
  /** 光标已切换、但历史没记上时的原因；正常为 null */
  warning: string | null;
}

/** 与 Rust 端 `utils::trash::TrashEntry` 字段一一对应 */
export interface TrashEntry {
  /** 回收站条目 ID（与主题 ID 分开：同一主题可以删多次） */
  id: string;
  /** 原主题 ID，恢复时作为主题目录名 */
  theme_id: string;
  /** 删除时的显示名快照 */
  name: string;
  /** 本地时区 `YYYY-MM-DD HH:MM` */
  deleted_at: string;
  slot_count: number;
  bytes: number;
  /** "ok" | "damaged"；damaged 时无法恢复，只能彻底删除 */
  status: "ok" | "damaged";
  error: string | null;
}

/** `list_trash` 的返回值：条目 + 当前生效的限额 */
export interface TrashListing {
  entries: TrashEntry[];
  max_entries: number;
  max_bytes: number;
}

/** `delete_theme` 的返回值：删除进回收站，可能伴随自动清理与残留提示 */
export interface DeleteOutcome {
  /** 本次因超出上限而被自动清理的旧条目数 */
  auto_purged: number;
  /** 非致命问题（典型：跨盘复制后原目录没能完全删除） */
  warning: string | null;
}

/** `delete_themes` 结果里的一条失败项（部分成功语义） */
export interface BatchDeleteFailure {
  theme_id: string;
  error: string;
}

/** `delete_themes` 的返回值：多选批量移入回收站（决策 43） */
export interface BatchDeleteOutcome {
  /** 成功移入回收站的主题 ID，顺序与入参去重后一致 */
  deleted: string[];
  /** 被拒绝的主题与原因；其余主题照常删除 */
  failed: BatchDeleteFailure[];
  /** 回收站超限时自动清理的旧条目数 */
  auto_purged: number;
  /** 非致命问题（典型：跨盘复制后原目录没能完全删除） */
  warning: string | null;
}

/** `restore_from_trash` 的返回值 */
export interface RestoreOutcome {
  warning: string | null;
}

/** `empty_trash` 的返回值 */
export interface EmptyTrashOutcome {
  removed: number;
  failed: string[];
}

/** 与 Rust 端 `commands::theme::SaveCurrentOutcome` 字段一一对应 */
export interface SaveCurrentOutcome {
  theme: CursorTheme;
  /** 捕获时被跳过的槽位说明 */
  warnings: string[];
  /** 实际复制进新主题的光标文件数 */
  file_count: number;
  /** 是否已经接管为当前主题 */
  applied: boolean;
  recent: HistoryEntry[];
  /** 未自动应用 / 应用后历史没记上时的原因 */
  warning: string | null;
}
