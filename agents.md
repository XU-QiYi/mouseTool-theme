# Agents — 鼠标光标主题管理工具

本项目采用 Tauri (Rust) + React (TypeScript) 架构，以下是各 Agent 的职责划分与协作说明。

---

## Agent 概览

| Agent | 职责 | 关键技术栈 |
|-------|------|------------|
| **Frontend Agent** | UI 界面、交互逻辑、状态管理 | React, TypeScript, Vite |
| **Backend Agent** | 系统级操作、注册表、文件 I/O | Rust, Tauri API, winapi |
| **Theme Agent** | 主题导入、解析、存储 | ZIP 处理, .cur/.ani 解析 |
| **Cursor Agent** | 光标预览、格式转换、动画渲染 | Canvas, GIF 生成 |
| **Registry Agent** | 注册表读写、系统 API 调用 | SystemParametersInfo, HKEY |
| **Integration Agent** | 前后端通信、Tauri Commands | IPC, serde, tauri::command |

---

## Frontend Agent

### 职责
- 构建主界面布局（左侧主题列表 + 右侧预览区）
- 实现主题卡片展示（缩略图、名称、导入日期）
- 拖拽导入交互（.zip 文件拖放）
- 主题应用状态管理（当前使用中 / 可选）
- 中文错误提示与 Toast 通知

### 关键文件
- `src/App.tsx` — 主应用入口
- `src/components/` — UI 组件（待创建）

### 注意事项
- 遵循 CLAUDE.md: 简洁代码，无过度抽象
- 界面风格参考 Windows 11 Fluent Design
- 支持中英文语言

---

## Backend Agent (Rust)

### 职责
- 实现 Tauri Commands 供前端调用
- 文件系统操作（解压、复制、目录管理）
- 配置文件读写（JSON/数据库）
- 错误处理与中文错误消息返回

### 关键文件
- `src-tauri/src/lib.rs` — Tauri 命令定义
- `src-tauri/src/main.rs` — 应用入口

### 当前状态
- 仅有 `greet` 示例命令，需扩展为实际功能

---

## Theme Agent

### 职责
- 解析 .zip 主题包结构
- 扫描 .cur / .ani 光标文件
- 解析 .inf 配置文件（光标槽位映射）
- 自动推断槽位（基于文件名关键字）
- 主题存储管理（Documents/MyCursorTool/Themes/）

### 后台处理流程
```
1. 解压 .zip → 临时目录
2. 扫描 .cur/.ani 文件
3. 解析 .inf 或自动推断槽位
4. 复制到主题目录
5. 清理临时文件
```

### 边界条件
- 同名主题处理（覆盖/重命名）
- 50MB 文件大小限制
- 临时目录自动清理

---

## Cursor Agent

### 职责
- .ani 动态光标预览
- 格式转换（.png/.jpg/.bmp → .cur）
- 热点坐标设置
- GIF 生成（用于预览播放）

### 预览方案
- **方案 A**: 导入时将 .ani 转为 GIF
- **方案 B**: 降级显示第一帧静态图

### 光标槽位
| 状态 | 用途 |
|------|------|
| Arrow | 默认指针 |
| Wait | 系统忙碌 |
| AppStarting | 程序加载 |
| IBeam | 文本输入 |
| Hand | 链接悬停 |
| Cross | 精确选择 |
| SizeAll | 窗口拖动 |
| SizeNS/WE/NWSE/NESW | 边框缩放 |
| No | 禁止操作 |

---

## Registry Agent

### 职责
- 读写 HKEY_CURRENT_USER\Control Panel\Cursors
- 调用 SystemParametersInfo API 刷新光标
- 恢复系统默认设置

### 注册表键值
```
HKEY_CURRENT_USER\Control Panel\Cursors
├── Arrow = "path\to\pointer.cur"
├── Wait = "path\to\wait.ani"
├── AppStarting = "path\to\appstarting.ani"
├── IBeam = "path\to\ibeam.cur"
├── Hand = "path\to\hand.cur"
├── Cross = "path\to\cross.cur"
├── SizeAll = "path\to\sizeall.cur"
├── SizeNS = "path\to\sizens.cur"
├── SizeWE = "path\to\sizewe.cur"
├── SizeNWSE = "path\to\sizenwse.cur"
├── SizeNESW = "path\to\sizenesw.cur"
└── No = "path\to\no.cur"
```

### API 调用
```rust
SystemParametersInfo(
    SPI_SETCURSORS,
    0,
    NULL,
    SPIF_UPDATEINIFILE | SPIF_SENDCHANGE
)
```

### 权限
- HKCU 注册表：普通用户即可操作
- 无需管理员权限/UAC

---

## Integration Agent

### 职责
- 定义前端 ↔ Rust 的 Tauri Commands
- 数据序列化（serde/serde_json）
- 错误类型统一定义

### 待实现 Commands
| Command | 功能 |
|---------|------|
| `import_theme` | 导入主题包 |
| `list_themes` | 获取主题列表 |
| `apply_theme` | 应用主题到系统 |
| `delete_theme` | 删除主题 |
| `rename_theme` | 重命名主题 |
| `export_theme` | 导出为 .zip |
| `create_custom_theme` | 创建自制方案 |
| `restore_default` | 恢复系统默认 |

---

## 协作流程

### 主题导入流程
```
用户拖拽 .zip
    ↓
Frontend: 调用 import_theme
    ↓
Backend: Theme Agent 解压 + 扫描
    ↓
Backend: Cursor Agent 转换 .ani → GIF
    ↓
Backend: 存储到主题目录
    ↓
Frontend: 刷新主题列表
```

### 主题应用流程
```
用户点击"应用此主题"
    ↓
Frontend: 调用 apply_theme
    ↓
Backend: Registry Agent 写入注册表
    ↓
Backend: 调用 SystemParametersInfo
    ↓
系统光标立即切换
```

---

## 非功能性要求

| 类别 | 要求 |
|------|------|
| 兼容性 | Windows 10/11, 32/64 位 |
| 性能 | 主题切换 < 500ms |
| 存储 | Documents/MyCursorTool/Themes/ |
| 错误处理 | 中文提示，无系统崩溃对话框 |
| 国际化 | 简体中文 |
