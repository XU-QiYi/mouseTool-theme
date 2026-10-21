```
技术栈：
- 前端：React 18 + TypeScript + Tailwind CSS 4
- UI 组件库：shadcn/ui
- 桌面框架：Tauri 2
- 状态管理：Zustand
- 后端语言：Rust

核心功能：
1. 读取 Windows 注册表中已安装的光标方案并展示
2. 预览光标文件（.cur 和 .ani 格式）
3. 一键应用光标方案到系统
4. 导入/导出光标主题包
5. 单个光标文件替换
6. 还原系统默认光标
```

## 架构约束提示词

text

```
请严格按照以下架构约束进行设计和编码：

【分层架构】
整个项目分为 4 层，每一层只和相邻层通信，不允许跨层调用：

第 1 层 - 页面层（pages/）
  职责：组合组件，管理页面级布局
  依赖：只能引用 components/ 和 stores/
  规则：不直接调用 services/，不直接调用 invoke()

第 2 层 - 组件层（components/）
  职责：UI 渲染和用户交互
  依赖：只能引用 stores/ 和 types/
  规则：不直接调用 services/，通过 store 的 action 间接触发

第 3 层 - 状态管理层（stores/）
  职责：管理全局状态，协调 UI 与数据
  依赖：只能引用 services/ 和 types/
  规则：每个 store 的 action 内部调用 service，然后更新 state

第 4 层 - 服务层（services/）
  职责：封装所有 Tauri invoke 调用
  依赖：只能引用 @tauri-apps/api 和 types/
  规则：每个函数对应一个 Rust command，返回类型与 Rust 端一一对应

【Rust 后端架构】
Rust 代码分为 3 层：

第 1 层 - commands/（命令层）
  职责：接收前端参数，编排业务逻辑，返回结果
  规则：每个文件对应一个功能模块，函数上方标注 #[tauri::command]

第 2 层 - models/（模型层）
  职责：定义所有数据结构（struct + enum）
  规则：所有结构体必须 derive Serialize 和 Deserialize

第 3 层 - utils/（工具层）
  职责：纯函数，处理具体的技术操作
  包括：注册表读写、文件操作、光标文件解析、Windows API 调用
  规则：不依赖 commands 层，可以被任意 command 调用

【类型系统】
前端 types/ 目录和 Rust models/ 目录中的数据结构必须保持一致。
前端的 CursorTheme、CursorSlot 等类型要和 Rust 端的同名结构体字段完全对应，
确保 invoke 调用时序列化/反序列化不会出错。
请严格按照以下架构约束进行设计和编码：

【分层架构】
整个项目分为 4 层，每一层只和相邻层通信，不允许跨层调用：

第 1 层 - 页面层（pages/）
  职责：组合组件，管理页面级布局
  依赖：只能引用 components/ 和 stores/
  规则：不直接调用 services/，不直接调用 invoke()

第 2 层 - 组件层（components/）
  职责：UI 渲染和用户交互
  依赖：只能引用 stores/ 和 types/
  规则：不直接调用 services/，通过 store 的 action 间接触发

第 3 层 - 状态管理层（stores/）
  职责：管理全局状态，协调 UI 与数据
  依赖：只能引用 services/ 和 types/
  规则：每个 store 的 action 内部调用 service，然后更新 state

第 4 层 - 服务层（services/）
  职责：封装所有 Tauri invoke 调用
  依赖：只能引用 @tauri-apps/api 和 types/
  规则：每个函数对应一个 Rust command，返回类型与 Rust 端一一对应

【Rust 后端架构】
Rust 代码分为 3 层：

第 1 层 - commands/（命令层）
  职责：接收前端参数，编排业务逻辑，返回结果
  规则：每个文件对应一个功能模块，函数上方标注 #[tauri::command]

第 2 层 - models/（模型层）
  职责：定义所有数据结构（struct + enum）
  规则：所有结构体必须 derive Serialize 和 Deserialize

第 3 层 - utils/（工具层）
  职责：纯函数，处理具体的技术操作
  包括：注册表读写、文件操作、光标文件解析、Windows API 调用
  规则：不依赖 commands 层，可以被任意 command 调用

【类型系统】
前端 types/ 目录和 Rust models/ 目录中的数据结构必须保持一致。
前端的 CursorTheme、CursorSlot 等类型要和 Rust 端的同名结构体字段完全对应，
确保 invoke 调用时序列化/反序列化不会出错。
```

## 功能模块提示词

### 模块一：注册表操作

text

```
请实现 Windows 注册表操作模块，要求：

1. 读取路径：HKEY_CURRENT_USER\Control Panel\Cursors\Schemes
   - 这个键下每个值的名称是方案名
   - 值的内容是逗号分隔的光标文件路径字符串
   - 路径顺序对应以下 15 种光标类型（按注册表默认顺序）：
     Arrow, AppStarting, Wait, Help, Crosshair, IBeam,
     NWPen, SizeAll, SizeNESW, SizeNS, SizeNWSE, SizeWE,
     UpArrow, Hand

2. 写入路径：HKEY_CURRENT_USER\Control Panel\Cursors
   - 需要为每种光标类型设置对应的文件路径值
   - 写入后必须调用 SystemParametersInfoW(SPI_SETCURSORS) 立即生效

3. 在 Schemes 子键下同时写入方案记录
   - 格式：方案名 → 逗号分隔的路径列表

使用的 Rust crate：
- winreg = "0.52"（注册表操作）
- windows = "0.56"（SystemParametersInfoW 调用）

注意事项：
- 读取注册表不需要管理员权限
- 写入 HKCU 不需要管理员权限
- 但复制文件到 C:\Windows\Cursors 需要管理员权限
- SystemParametersInfoW 调用需要在主线程或安全的上下文中执行
```

```
请实现 Windows 注册表操作模块，要求：

1. 读取路径：HKEY_CURRENT_USER\Control Panel\Cursors\Schemes
   - 这个键下每个值的名称是方案名
   - 值的内容是逗号分隔的光标文件路径字符串
   - 路径顺序对应以下 15 种光标类型（按注册表默认顺序）：
     Arrow, AppStarting, Wait, Help, Crosshair, IBeam,
     NWPen, SizeAll, SizeNESW, SizeNS, SizeNWSE, SizeWE,
     UpArrow, Hand

2. 写入路径：HKEY_CURRENT_USER\Control Panel\Cursors
   - 需要为每种光标类型设置对应的文件路径值
   - 写入后必须调用 SystemParametersInfoW(SPI_SETCURSORS) 立即生效

3. 在 Schemes 子键下同时写入方案记录
   - 格式：方案名 → 逗号分隔的路径列表

使用的 Rust crate：
- winreg = "0.52"（注册表操作）
- windows = "0.56"（SystemParametersInfoW 调用）

注意事项：
- 读取注册表不需要管理员权限
- 写入 HKCU 不需要管理员权限
- 但复制文件到 C:\Windows\Cursors 需要管理员权限
- SystemParametersInfoW 调用需要在主线程或安全的上下文中执行
```

### 模块二：光标文件解析

text

```
请实现光标文件解析模块，要求：

1. 解析 .cur 文件
   - .cur 本质是 ICO 格式，包含文件头 + 图像数据
   - 需要提取：宽度、高度、位深度、热区坐标（hotspot）
   - 输出为 PNG 格式的 base64 字符串，供前端渲染

2. 解析 .ani 文件
   - .ani 基于 RIFF 容器格式
   - 需要提取：帧序列、每帧持续时间（rate）、总帧数
   - 输出为 PNG 帧数组的 base64 字符串列表 + 帧率信息
   - 前端用 canvas 逐帧播放

3. 输入输出接口：
   - 输入：文件系统路径（String）
   - 输出：CursorPreview { is_animated: bool, image: String, frames: Vec<String>, rate_ms: u32 }

使用的 Rust crate：
- image = "0.25"（图片解码）
- base64 = "0.22"（编码）

注意：
- 某些 .cur 文件内嵌的图像格式可能是 BMP 或 PNG，需要兼容处理
- 高分辨率光标可能包含多种尺寸（16/32/48/256px），优先输出最大的
- 解析失败不应导致程序崩溃，返回空预览即可
```

```
请实现光标文件解析模块，要求：

1. 解析 .cur 文件
   - .cur 本质是 ICO 格式，包含文件头 + 图像数据
   - 需要提取：宽度、高度、位深度、热区坐标（hotspot）
   - 输出为 PNG 格式的 base64 字符串，供前端渲染

2. 解析 .ani 文件
   - .ani 基于 RIFF 容器格式
   - 需要提取：帧序列、每帧持续时间（rate）、总帧数
   - 输出为 PNG 帧数组的 base64 字符串列表 + 帧率信息
   - 前端用 canvas 逐帧播放

3. 输入输出接口：
   - 输入：文件系统路径（String）
   - 输出：CursorPreview { is_animated: bool, image: String, frames: Vec<String>, rate_ms: u32 }

使用的 Rust crate：
- image = "0.25"（图片解码）
- base64 = "0.22"（编码）

注意：
- 某些 .cur 文件内嵌的图像格式可能是 BMP 或 PNG，需要兼容处理
- 高分辨率光标可能包含多种尺寸（16/32/48/256px），优先输出最大的
- 解析失败不应导致程序崩溃，返回空预览即可
```

### 模块三：主题管理

text

```
请实现主题管理模块，包含以下功能：

【本地存储结构】
用户导入的主题存储在 %LOCALAPPDATA%\CursorStudio\themes\ 目录下：
  themes/
  ├── {theme-id-1}/
  │   ├── theme.json          ← 主题元数据
  │   └── cursors/            ← 光标文件副本
  │       ├── arrow.cur
  │       ├── hand.ani
  │       └── ...
  └── {theme-id-2}/
      └── ...

theme.json 格式：
{
  "id": "uuid",
  "name": "主题名称",
  "description": "描述",
  "created_at": "ISO 8601",
  "updated_at": "ISO 8601",
  "is_built_in": false,
  "cursors": [
    {
      "registry_key": "Arrow",
      "display_name": "正常选择",
      "english_name": "Normal Select",
      "file_path": "cursors/arrow.cur",
      "file_type": "cur"
    }
  ]
}

【功能清单】

1. 获取所有主题
   - 合并系统注册表方案（标记 is_built_in: true）
   - 和本地 themes/ 目录下的用户主题
   - 系统方案的 ID 格式：sys_{方案名}
   - 用户主题的 ID 格式：UUID

2. 导入主题
   - 支持导入文件夹（包含 theme.json + cursors/ 子目录）
   - 支持导入 zip 压缩包（解压后同上结构）
   - 自动生成 UUID 作为主题 ID
   - 复制光标文件到本地 themes/{id}/cursors/

3. 应用主题
   - 系统内置主题：直接修改注册表中的光标路径
   - 用户导入主题：
     a. 先把光标文件复制到 C:\Windows\Cursors（需要 UAC 提权）
     b. 修改注册表指向系统目录下的新路径
     c. 调用 SystemParametersInfoW 刷新

4. 导出主题
   - 将主题文件夹打包为 zip
   - 包含 theme.json + cursors/ 下所有文件

5. 删除主题
   - 不允许删除系统内置主题
   - 用户主题：删除本地 themes/{id}/ 目录

6. 还原默认
   - 将注册表中每种光标类型重置为 Windows 默认文件名
   - 路径：C:\Windows\Cursors\arrow.cur 等
   - 调用 SystemParametersInfoW 刷新
```

```
请实现主题管理模块，包含以下功能：

【本地存储结构】
用户导入的主题存储在 %LOCALAPPDATA%\CursorStudio\themes\ 目录下：
  themes/
  ├── {theme-id-1}/
  │   ├── theme.json          ← 主题元数据
  │   └── cursors/            ← 光标文件副本
  │       ├── arrow.cur
  │       ├── hand.ani
  │       └── ...
  └── {theme-id-2}/
      └── ...

theme.json 格式：
{
  "id": "uuid",
  "name": "主题名称",
  "description": "描述",
  "created_at": "ISO 8601",
  "updated_at": "ISO 8601",
  "is_built_in": false,
  "cursors": [
    {
      "registry_key": "Arrow",
      "display_name": "正常选择",
      "english_name": "Normal Select",
      "file_path": "cursors/arrow.cur",
      "file_type": "cur"
    }
  ]
}

【功能清单】

1. 获取所有主题
   - 合并系统注册表方案（标记 is_built_in: true）
   - 和本地 themes/ 目录下的用户主题
   - 系统方案的 ID 格式：sys_{方案名}
   - 用户主题的 ID 格式：UUID

2. 导入主题
   - 支持导入文件夹（包含 theme.json + cursors/ 子目录）
   - 支持导入 zip 压缩包（解压后同上结构）
   - 自动生成 UUID 作为主题 ID
   - 复制光标文件到本地 themes/{id}/cursors/

3. 应用主题
   - 系统内置主题：直接修改注册表中的光标路径
   - 用户导入主题：
     a. 先把光标文件复制到 C:\Windows\Cursors（需要 UAC 提权）
     b. 修改注册表指向系统目录下的新路径
     c. 调用 SystemParametersInfoW 刷新

4. 导出主题
   - 将主题文件夹打包为 zip
   - 包含 theme.json + cursors/ 下所有文件

5. 删除主题
   - 不允许删除系统内置主题
   - 用户主题：删除本地 themes/{id}/ 目录

6. 还原默认
   - 将注册表中每种光标类型重置为 Windows 默认文件名
   - 路径：C:\Windows\Cursors\arrow.cur 等
   - 调用 SystemParametersInfoW 刷新
```

### 模块四：前端状态管理

text

```
请使用 Zustand 实现前端状态管理，要求：

【themeStore 结构】
状态：
  - themes: CursorTheme[]         // 所有主题
  - activeThemeId: string | null  // 当前系统正在使用的主题 ID
  - selectedThemeId: string | null // 界面中选中的主题 ID
  - searchQuery: string           // 搜索关键词
  - currentPage: "library" | "imported" | "recent"  // 当前页面
  - loading: boolean              // 加载状态

派生数据（用 getter 函数实现）：
  - selectedTheme()     → 根据 selectedThemeId 返回对应主题对象
  - filteredThemes()    → 根据 currentPage 和 searchQuery 过滤主题列表

Action：
  - loadThemes()        → 调用 service 获取数据，更新 themes 和 activeThemeId
  - selectTheme(id)     → 更新 selectedThemeId
  - applyTheme(id)      → 调用 service 应用主题，更新 activeThemeId
  - deleteTheme(id)     → 调用 service 删除，从 themes 中移除
  - importTheme(path)   → 调用 service 导入，追加到 themes
  - restoreDefault()    → 调用 service 还原，清空 activeThemeId
  - setSearchQuery(q)   → 更新 searchQuery
  - setCurrentPage(p)   → 更新 currentPage

【数据流规则】
1. 组件不直接调用 service，必须通过 store 的 action
2. Action 内部：先调 service → 拿到结果 → 更新 state
3. 异常处理在 action 内部统一 catch，不向上抛出
4. loadThemes 在 App 初始化时调用一次
```

```
请使用 Zustand 实现前端状态管理，要求：

【themeStore 结构】
状态：
  - themes: CursorTheme[]         // 所有主题
  - activeThemeId: string | null  // 当前系统正在使用的主题 ID
  - selectedThemeId: string | null // 界面中选中的主题 ID
  - searchQuery: string           // 搜索关键词
  - currentPage: "library" | "imported" | "recent"  // 当前页面
  - loading: boolean              // 加载状态

派生数据（用 getter 函数实现）：
  - selectedTheme()     → 根据 selectedThemeId 返回对应主题对象
  - filteredThemes()    → 根据 currentPage 和 searchQuery 过滤主题列表

Action：
  - loadThemes()        → 调用 service 获取数据，更新 themes 和 activeThemeId
  - selectTheme(id)     → 更新 selectedThemeId
  - applyTheme(id)      → 调用 service 应用主题，更新 activeThemeId
  - deleteTheme(id)     → 调用 service 删除，从 themes 中移除
  - importTheme(path)   → 调用 service 导入，追加到 themes
  - restoreDefault()    → 调用 service 还原，清空 activeThemeId
  - setSearchQuery(q)   → 更新 searchQuery
  - setCurrentPage(p)   → 更新 currentPage

【数据流规则】
1. 组件不直接调用 service，必须通过 store 的 action
2. Action 内部：先调 service → 拿到结果 → 更新 state
3. 异常处理在 action 内部统一 catch，不向上抛出
4. loadThemes 在 App 初始化时调用一次
```

### 模块五：前端组件设计

text

```
请按以下组件树结构实现前端界面：

App
├── Sidebar（左侧导航栏，固定宽度 w-56）
│   ├── Logo 区域：应用名 + 版本号
│   ├── 导入主题按钮：调用系统文件夹选择器
│   ├── 导航菜单：主题图库 / 已导入 / 最近使用
│   │   每个菜单项对应 setCurrentPage()
│   └── 底部：应用设置入口
│
├── ThemeList（中间列表区，固定宽度 w-72，可滚动）
│   ├── 搜索框：输入时更新 searchQuery
│   └── ThemeCard[]：遍历 filteredThemes()
│       ├── 光标预览图标（取第一个光标的预览图）
│       ├── 主题名称
│       ├── 更新时间
│       └── 如果是 activeThemeId 显示"当前使用"徽章
│       点击时调用 selectTheme(id)
│
└── ThemeDetail（右侧详情区，flex-1 填满剩余宽度）
    ├── 顶部区域（flex 布局）
    │   ├── 左：主题封面大图
    │   └── 右：主题名 + 描述 + "应用此主题"按钮 + "导出为 ZIP"按钮
    ├── CursorGrid（光标预览网格，grid-cols-4）
    │   └── CursorSlotCard[]：遍历 selectedTheme().cursors
    │       ├── 光标预览图
    │       ├── 中文名称
    │       ├── 英文名称
    │       └── 如果是 .ani 格式显示 ANI 标签
    │       点击时弹出文件选择器替换该光标
    ├── 底部信息：最后修改时间
    └── 操作区：删除此主题（红色） + 还原系统默认

【组件规则】
1. 所有 UI 组件（Button, Card, Badge, Dialog 等）从 shadcn/ui 引入
2. 图标从 lucide-react 引入
3. 自定义组件放在 src/components/cursor/ 和 src/components/theme/ 下
4. 布局组件放在 src/components/layout/ 下
5. 组件只负责渲染，业务逻辑放在 store 的 action 中
6. Toast 提示使用 sonner 库
```

```
请按以下组件树结构实现前端界面：

App
├── Sidebar（左侧导航栏，固定宽度 w-56）
│   ├── Logo 区域：应用名 + 版本号
│   ├── 导入主题按钮：调用系统文件夹选择器
│   ├── 导航菜单：主题图库 / 已导入 / 最近使用
│   │   每个菜单项对应 setCurrentPage()
│   └── 底部：应用设置入口
│
├── ThemeList（中间列表区，固定宽度 w-72，可滚动）
│   ├── 搜索框：输入时更新 searchQuery
│   └── ThemeCard[]：遍历 filteredThemes()
│       ├── 光标预览图标（取第一个光标的预览图）
│       ├── 主题名称
│       ├── 更新时间
│       └── 如果是 activeThemeId 显示"当前使用"徽章
│       点击时调用 selectTheme(id)
│
└── ThemeDetail（右侧详情区，flex-1 填满剩余宽度）
    ├── 顶部区域（flex 布局）
    │   ├── 左：主题封面大图
    │   └── 右：主题名 + 描述 + "应用此主题"按钮 + "导出为 ZIP"按钮
    ├── CursorGrid（光标预览网格，grid-cols-4）
    │   └── CursorSlotCard[]：遍历 selectedTheme().cursors
    │       ├── 光标预览图
    │       ├── 中文名称
    │       ├── 英文名称
    │       └── 如果是 .ani 格式显示 ANI 标签
    │       点击时弹出文件选择器替换该光标
    ├── 底部信息：最后修改时间
    └── 操作区：删除此主题（红色） + 还原系统默认

【组件规则】
1. 所有 UI 组件（Button, Card, Badge, Dialog 等）从 shadcn/ui 引入
2. 图标从 lucide-react 引入
3. 自定义组件放在 src/components/cursor/ 和 src/components/theme/ 下
4. 布局组件放在 src/components/layout/ 下
5. 组件只负责渲染，业务逻辑放在 store 的 action 中
6. Toast 提示使用 sonner 库
```

------

## 开发顺序提示词

text

```
请按照以下顺序逐步实现，每完成一个阶段可以独立运行和验证：

【阶段 1】项目初始化（验证环境）
1. 用 create-tauri-app 创建 Tauri + React + TypeScript 项目
2. 配置 Tailwind CSS 4 + Vite 插件
3. 初始化 shadcn/ui
4. 验证 npm run tauri dev 能正常启动窗口

【阶段 2】后端基础（验证数据读取）
1. 在 Cargo.toml 中添加 winreg、windows、serde 依赖
2. 实现注册表读取函数，列出系统光标方案
3. 创建 Tauri command get_all_themes
4. 在 main.rs 中注册 command
5. 在 React 中 invoke 调用，console.log 打印结果

【阶段 3】前端基础布局（验证界面）
1. 实现 Sidebar 组件（导航菜单）
2. 实现 ThemeList + ThemeCard 组件（连接 store）
3. 实现 ThemeDetail + CursorGrid + CursorSlotCard 组件
4. 搭建三栏布局
5. 接入 Zustand store

【阶段 4】光标预览（验证图片解析）
1. 在 Cargo.toml 中添加 image、base64 依赖
2. 实现 get_cursor_preview command
3. CursorSlotCard 中显示光标预览图
4. 处理文件不存在的异常情况

【阶段 5】应用光标方案（验证核心功能）
1. 实现 apply_theme command（写注册表 + SystemParametersInfoW）
2. "应用此主题"按钮连接 store action
3. 验证点击后系统光标立即变化
4. 实现 restore_default command
5. "还原系统默认"按钮连接

【阶段 6】导入导出（验证文件操作）
1. 添加 tauri-plugin-dialog 依赖
2. 前端集成文件夹选择器
3. 实现 import_theme command（解压 + 复制 + 写 theme.json）
4. 实现 export_theme command（打包 zip）
5. 导入后列表自动刷新

【阶段 7】体验完善
1. 添加加载状态（loading spinner）
2. 添加空状态提示（没有主题时的占位图）
3. 添加 Toast 提示（成功/失败）
4. 搜索过滤功能
5. 页面切换功能
6. 窗口尺寸适配
请按照以下顺序逐步实现，每完成一个阶段可以独立运行和验证：

【阶段 1】项目初始化（验证环境）
1. 用 create-tauri-app 创建 Tauri + React + TypeScript 项目
2. 配置 Tailwind CSS 4 + Vite 插件
3. 初始化 shadcn/ui
4. 验证 npm run tauri dev 能正常启动窗口

【阶段 2】后端基础（验证数据读取）
1. 在 Cargo.toml 中添加 winreg、windows、serde 依赖
2. 实现注册表读取函数，列出系统光标方案
3. 创建 Tauri command get_all_themes
4. 在 main.rs 中注册 command
5. 在 React 中 invoke 调用，console.log 打印结果

【阶段 3】前端基础布局（验证界面）
1. 实现 Sidebar 组件（导航菜单）
2. 实现 ThemeList + ThemeCard 组件（连接 store）
3. 实现 ThemeDetail + CursorGrid + CursorSlotCard 组件
4. 搭建三栏布局
5. 接入 Zustand store

【阶段 4】光标预览（验证图片解析）
1. 在 Cargo.toml 中添加 image、base64 依赖
2. 实现 get_cursor_preview command
3. CursorSlotCard 中显示光标预览图
4. 处理文件不存在的异常情况

【阶段 5】应用光标方案（验证核心功能）
1. 实现 apply_theme command（写注册表 + SystemParametersInfoW）
2. "应用此主题"按钮连接 store action
3. 验证点击后系统光标立即变化
4. 实现 restore_default command
5. "还原系统默认"按钮连接

【阶段 6】导入导出（验证文件操作）
1. 添加 tauri-plugin-dialog 依赖
2. 前端集成文件夹选择器
3. 实现 import_theme command（解压 + 复制 + 写 theme.json）
4. 实现 export_theme command（打包 zip）
5. 导入后列表自动刷新

【阶段 7】体验完善
1. 添加加载状态（loading spinner）
2. 添加空状态提示（没有主题时的占位图）
3. 添加 Toast 提示（成功/失败）
4. 搜索过滤功能
5. 页面切换功能
6. 窗口尺寸适配
```

## 调试与验证提示词

text

```
在开发过程中，每个阶段完成后请执行以下验证：

【阶段 1 验证】
□ npm run tauri dev 能启动窗口
□ 窗口中显示 React 页面内容

【阶段 2 验证】
□ Rust 能编译通过
□ invoke 返回的数组中包含 "Windows Default" 等已知方案名
□ 每个方案包含正确的光标路径

【阶段 3 验证】
□ 左侧导航栏可点击切换
□ 中间列表显示主题卡片
□ 点击卡片后右侧显示详情
□ 光标网格显示 14 个槽位

【阶段 4 验证】
□ .cur 文件显示为可见的光标图片
□ .ani 文件不导致程序崩溃（可以先显示第一帧或占位图）
□ 不存在的文件路径显示占位图标

【阶段 5 验证】
□ 点击"应用此主题"后系统鼠标光标实际发生变化
□ 点击"还原系统默认"后光标恢复为 Windows 默认
□ 在系统设置 > 鼠标中能看到方案已更新

【阶段 6 验证】
□ 导入一个光标主题文件夹后出现在列表中
□ 导入的光标可以正常预览
□ 应用导入的主题后系统光标变化
□ 导出生成的 zip 包含完整文件结构
在开发过程中，每个阶段完成后请执行以下验证：

【阶段 1 验证】
□ npm run tauri dev 能启动窗口
□ 窗口中显示 React 页面内容

【阶段 2 验证】
□ Rust 能编译通过
□ invoke 返回的数组中包含 "Windows Default" 等已知方案名
□ 每个方案包含正确的光标路径

【阶段 3 验证】
□ 左侧导航栏可点击切换
□ 中间列表显示主题卡片
□ 点击卡片后右侧显示详情
□ 光标网格显示 14 个槽位

【阶段 4 验证】
□ .cur 文件显示为可见的光标图片
□ .ani 文件不导致程序崩溃（可以先显示第一帧或占位图）
□ 不存在的文件路径显示占位图标

【阶段 5 验证】
□ 点击"应用此主题"后系统鼠标光标实际发生变化
□ 点击"还原系统默认"后光标恢复为 Windows 默认
□ 在系统设置 > 鼠标中能看到方案已更新

【阶段 6 验证】
□ 导入一个光标主题文件夹后出现在列表中
□ 导入的光标可以正常预览
□ 应用导入的主题后系统光标变化
□ 导出生成的 zip 包含完整文件结构
```