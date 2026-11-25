# 设计系统

[English](design-system.md) · **简体中文**

本文档固化 Mystry Dashboard Web 界面的视觉层级、颜色、字号、圆角、组件规范与页面写作规则。设计或修改 `apps/web` 下的页面、组件与用户可见文案时，一律按本文档执行。多语言写作规范与从右到左布局见 [Localization](localization.md)。

- 唯一事实来源：[`apps/web/src/styles.css`](../apps/web/src/styles.css)（变量与全部组件类）和 [`apps/web/src/i18n/`](../apps/web/src/i18n/)（文案）。若文档与代码不一致，以代码为准，并在同一次改动中同步修正本文档的中英两版。
- 可视参考：[Mystry Dashboard 设计系统 Artifact](https://claude.ai/artifact/L1qMsnhfkv7rZ68ifVdke6) 提供明暗两种外观下的组件实时预览（私有，需向所有者申请访问）。它是 `styles.css` 在 `edfb414` 时的快照，早于内容面板和陶土橙强调色，不会自动更新。
- 下文提到的变量名均对应 `styles.css` 中的 CSS 自定义属性，例如 `accent` 指 `var(--accent)`。字号全部使用 `--text-*` 变量，其余标明 `px` 的数值是源码里的固定字面量。

## 文案规范

- 直接平实，称呼用户用「你」（英文用 "you"），不使用感叹号、玩笑语气和 emoji。说清会发生什么、不会发生什么。
- 按钮写具体动作，中文两到四个字，英文一到三个词（如「启动」「上传备份」「选择 ZIP」）。不可逆的危险确认按钮必须写明后果（如「强制停止」「永久删除」「移除记录」）。
- 页面标题用名词（如「实例总览」「一键部署」「导入服务端」「本机环境」「面板设置」）。
- **不在标签页顶部常驻解释句**：不要在页面顶部堆砌「这些设置保存在 server.properties，重启实例后生效」「每个备份都是完整副本」这类说明文字。归属关系靠标签页本身和文件管理体现；运行时限制只在条件成立时通过短状态标签（如运行中备份页的「还原需先停服」）、保存条或确认框呈现。
- **后台功能按状态轻重分层**：例如定时备份在正常完成时不单独占状态行，只在最近一次失败时用 `callout-danger` 醒目提示失败时间、原因和上一次成功时间。
- 状态词固定取自 `apps/web/src/i18n/en/common.ts` 术语表：已停止、启动中、运行中、停止中、已崩溃、待迁移；任务状态为排队中、进行中、已完成、失败、已取消。已取消任务在数据中仍为 `failed`，但任务中心用中性灰显示「已取消」，因为用户主动取消不是错误。
- 空状态要给出明确下一步（标题 + 一句话 + 主按钮，或像空总览页一样列出完整行入口）；报错必须同时说明原因和解决办法，不能只丢错误码。
- 保留技术名词原文不翻译：`Paper`、`Fabric`、`JVM`、`server.properties`、`ZIP`。数字与单位之间留空格（`4 GB`、`3 / 5`）。
- 所有用户可见文案必须写入 `i18n` 语言表，禁止在组件中硬编码，详见 [Localization](localization.md)。

## 视觉基础

### 三层结构与两种材质

整站严格划分为三层，这是视觉层级最核心的规则：

1. **底层：页面底布（`bg`）**
   - 亮色 `#f5f5f7`，暗色 `#1e1e20`（参照 macOS 深色外观用石墨灰，不用近黑），纯色平铺，不加装饰性渐变背景。
   - 承载页面标题、区块标题、顶部操作栏、主机资源条（`.host-strip`）和说明栏（`.deploy-guide`）。

2. **中层：一级内容容器（macOS/iOS 内嵌分组表面）**
   - 所有分组列表（`.list-group`）、表单分组（`.form-card`）、资源列表（总览 `.server-list`、文件管理 `.file-list`、备份列表 `.backup-list`）、定时备份控制条（`.backups-schedule`）、空状态（`.empty-state.card`）和空总览入口列表（`.start-path-list`），**固定使用同一套实色圆角容器**：
     - 底色：`surface`（亮 `#ffffff` / 暗 `#2a2a2d`，暗色下比底布亮一档）
     - 边框：`1px solid var(--panel-border)`（亮 `rgba(0, 0, 0, 0.11)` / 暗 `rgba(255, 255, 255, 0.09)`）
     - 投影：`panel-shadow`（亮 `0 1px 2px rgba(0, 0, 0, 0.05), 0 2px 6px rgba(0, 0, 0, 0.03)` / 暗 `inset 0 1px 0 rgba(255, 255, 255, 0.04)`），不做厚重浮空阴影
     - 圆角：`radius-md`（`14px`），列表容器加 `overflow: hidden`
   - 区块标题（`.form-section-title`）放在容器**外部上方**，左缘轻微对齐（`margin-inline-start: 4px`），不加多余底线。
   - 容器内部行之间使用 `0.5px solid var(--separator)` 内缩细分隔线（表单行从 `18px` 起，带左侧图标的列表行对齐文字起点 `66px` / `78px`）。
   - **禁止容器套容器**：嵌套在 `.form-card` 内部的 `.list-group` 自动降级为 `fill-2` 底色、透明边框、`radius-sm` 圆角、无投影。
   - 侧边阅读说明（`.deploy-guide`）留在底布上，用左侧 `0.5px` `separator-strong` 竖线隔开。
   - 独立可点卡片和浮出面板（部署核心选择块、登录卡片、迁移面板、原生弹窗、任务抽屉）保留 `surface` + `card-shadow`。

3. **顶层：导航与浮层（毛玻璃材质）**
   - 侧边栏、顶栏胶囊按钮组、弹出菜单、气泡面板、底部悬浮操作条（`.action-bar`）和手机底栏使用毛玻璃：`material`、`material-thick` 或 `menu-bg`，配合 `backdrop-filter: blur(24–40px) saturate(180%)` 与 `glass-edge` 细描边。
   - 顶栏本身没有通栏横条。页面滚动后出现的标题胶囊与右侧按钮组各自悬浮；内容滚到下方时，`.topbar::before` 叠加向下渐隐的轻模糊遮罩，不画硬底线。
   - `≤768px` 时仅底部 tab 栏保留模糊。顶栏胶囊、侧栏抽屉、悬浮操作条关闭 `backdrop-filter` 改用近不透明的 `material-flat`；顶栏滚动边缘改用 94% `bg` 渐隐；任务抽屉用不带模糊的 `sheet-bg`，弹窗切换为实色 `sheet-bg-solid`，避免手机 GPU 叠加多层模糊掉帧。临时弹出的菜单和气泡保留模糊。
   - 侧栏底色用 `sidebar-bg`（亮色是比内容区略深的半透明浅灰），当前页用 `select-fill` 浅灰底标出，文字和图标用 `label`，和 Finder 的侧栏一致。
   - 铁律：内容层绝不用毛玻璃，导航层绝不做成实色块。

### 色彩

- 外观由 `<html>` 上的 `data-appearance="light|dark"` 控制（自动模式会解析为两者之一），暗色变量集中在 `:root[data-appearance='dark']`。
- 文字：`label`（主文字）、`label-2`（次级说明、字段标签）、`label-3`（仅用于占位提示、箭头和分隔符，对比度低于 4.5:1，禁止用于正文）。
- 填充：`fill-2`（悬停、嵌套子列表、辅助底色）、`fill`（分段轨道、徽章、快捷芯片）、`fill-strong`（加载轨道）。普通按钮和输入框参照 macOS：白底（`control-bg`、`input-bg`，暗色为半透明白）加细线（按钮 `control-edge`，输入框 `field-edge`）。输入框聚焦时切为 `surface` + `1px` `accent` 描边 + `3px` `focus-soft` 外晕；细线写成零优先级的 `:where()` 规则，聚焦和报错的描边总能盖过它。
- **固定陶土橙强调色**（非用户可配项）：亮色填充 `#bc4f1f`、文字 `#a94617`，暗色填充 `#c2541f`、文字 `#ff9a6b`，填充上的文字均为白色 `on-accent`。用法照 macOS 的强调色：主操作、打开或勾选的控件（开关、复选框、选中的核心卡片和外观选项）、焦点、进度条、菜单与下拉的高亮。导航选中项、链接、图标、徽标一律中性。组件内只能引用 `accent`（填充）、`accent-text`（带色文字，目前只有 `btn-tinted` 和语言选中的对勾）和 `on-accent`，禁止写死十六进制色值。`accent-soft`（13%）、`focus-ring`（45%，键盘焦点框）和 `focus-soft`（22%，输入框外晕）通过 `color-mix` 派生；`console-focus` 由强调色混入 35% 白色，在深色控制台上不低于 6.7:1。
- **两套语义色**：`c-green`、`c-blue`、`c-yellow`、`c-red`、`c-gray` 只用于图标和 11–16% 淡底混色；文字用 `ok`、`warn`、`danger`，确保在淡底混色加 `bg` 或 `surface` 的最差情况下仍达到 4.5:1。实心危险按钮用 `danger-fill` 配白字（暗色模式下比 `c-red` 深一档，不与 `danger` 混用）。
- 状态映射（红绿灯）：运行中 → 绿；启动中、停止中、待迁移、排队中的任务和各类警告 → 琥珀黄（`c-yellow` 配 `warn` 文字）；已崩溃、失败 → 红；已停止 → 灰。警示不用橙色，橙色只表示「在这里操作」。状态必须同时带文字，不能只靠颜色区分。
- **控制台始终深色**（不随明暗切换）：窗口 `#161618`、顶底栏 `#1f1f22`、主文 `#e5e5ea`、弱文 `#aeaeb2`、提示符 `#30d158`，聚焦圈使用 `console-focus`。
- 品牌渐变只允许出现在品牌图标 `BrandMark` 上（145° `#ff73b0` → `#c64fd6` 52% → `#7a4df0`），是全站唯一渐变。各服务端核心图标（`.core-paper`、`.core-fabric` 等）用单一纯色 `--core`，无渐变和彩色阴影，白色图标对比度 ≥3:1。用户头像与「本机环境」图标用纯灰。

### 字体与字号

- 使用系统字体栈 `--font`，不请求外部字体服务。`:root:lang(zh-TW)` 将繁体中文字体排在简体字体之前。等宽字体为 `--mono`。
- 正文为 `15px / 1.47`，字距 `-0.005em`；标题收紧至 `-0.015` 到 `-0.026em`。
- **字号只能从 `:root` 的八档 `--text-*` 中按角色选取**，禁止在组件里写散落的像素值或半像素档：

  | 变量 | 尺寸 | 用途 |
  |---|---|---|
  | `text-large` | 30px | 每页唯一大标题、实例名、登录页标题 |
  | `text-title` | 22px | 区块大标题、总览状态句、任务抽屉标题、`≤768px` 时的实例名 |
  | `text-headline` | 17px | 弹窗与空状态标题、总览服务器名、`.btn-lg` |
  | `text-input` | 16px | 触屏设备输入框与登录输入框（防止 iOS 聚焦放大，非视觉字号档） |
  | `text-body` | 15px | 正文、按钮、导航项、菜单项、列表标题、输入框、实例页签 |
  | `text-small` | 13px | 字段标签（半粗）、帮助与说明、状态胶囊、快捷芯片、`.btn-sm`、元信息、`≤480px` 实例页签 |
  | `text-footnote` | 12px | 代码、路径、时间戳、小注、计数与来源徽章 |
  | `text-micro` | 11px | 手机底栏文字与顶栏角标专用 |

  相邻层级的文字同时用字重或颜色拉开区分（例如字段标签为 13px 半粗 `label-2`，下方帮助为 13px 常规 `label-2`）。
- 所有数字、体积、进度、时间列表统一启用 `font-variant-numeric: tabular-nums`。
- 触屏（`pointer: coarse`）和 `≤768px` 下所有输入框、下拉框、文本域强制至少 `16px`。
- JVM 参数、路径、命令与文件内容使用 `--mono`，`13px / 1.55`。

### 圆角、控件几何与间距

- **同心圆角梯度**（外大内小）：`radius-xl` 22px（侧栏、弹窗）> `radius-lg` 18px（独立卡片、底部操作条）> `radius-md` 14px（内容分组容器、列表、提示条、菜单）> `radius-sm` 10px（输入框、常规按钮、分段控件外框、实例页签托盘）> `radius-xs` 7px（小按钮 `.btn-sm`、快捷芯片、控制台工具按钮、分段项、实例页签选中块）。
- **交互按钮一律方形圆角，被动指示器保留胶囊**：
  - `.btn`、`.btn-icon`、`.segmented`、`.hub-tabs` 使用 `radius-sm`（`10px`）；`.btn-sm`、`.chip`、`.console-tool`、`.segmented-item`、`.hub-tab` 使用 `radius-xs`（`7px`）。
  - 状态标签（`.status-pill`、`.environment-status`）、计数与来源徽章（`.count-badge`、`.toolbar-badge`、`.backup-source`）、开关（`.switch`）、进度条（`.progress`、`.meter`）以及顶栏悬浮玻璃胶囊（`.toolbar-title`、`.toolbar-group`、`.toolbar-button`、`.tab-bar`）保留 `radius-pill`（`999px`），在形状上把「可点操作」和「只读状态」一眼分开。
- 控件高度：常规按钮 `34px`（`.btn-sm` `28px`，`.btn-lg` `46px`）；输入框至少 `38px`。
- **触控目标（`pointer: coarse`）至少 `44×44px`**：常规按钮、图标按钮、顶栏按钮、分段项、菜单项、导航项、页签、芯片、折叠标题与输入框增高到 `44px`；`.btn-sm`、`.link-button` 和 `.back-link` 保持外观不变，通过透明 `::after` 伪元素把命中区外扩至 `44px`。桌面端密度不变。
- 骨架间距：页面区块间距 `24px`（`--page-gap`），实例页 `20px`（`--instance-page-gap`），表单分组内 `10px`（`--form-section-gap`），网格 `16px`，区块标题下 `14px`，分组容器内边距 `18px 20px`（列表行 `12px 18px`），页面左右边距桌面 `40px`（`≤1024px` 为 `28px`，`≤768px` 为 `16px`），最大内容宽 `1240px`，侧栏宽 `256px`，顶栏高 `60px`。
- 矮桌面档：当视口高度 `<820px` 且宽度 `≥1025px`（高缩放笔记本）时，`:root` 整体收紧顶栏高 `56px`、页面间距 `18px`、实例页间距 `14px`、分组间距 `8px`、取消顶部额外留白，大标题保持 `30px`。

### 阴影

- 内容容器使用轻量的 `panel-shadow` + `1px` `panel-border`；独立卡片（部署核心块、登录页、迁移面板）使用 `card-shadow`；悬浮组件使用 `float-shadow`；弹窗与任务抽屉使用 `sheet-shadow`。核心选择块悬停不上浮、不加深阴影，只叠 `hover-overlay`。

### 交互与动效

- 悬停叠 `hover-overlay`，按下叠 `active-overlay` 并缩放到 `0.97`。禁用态不透明度 `0.42`，指针为 `not-allowed`。
- 键盘聚焦：`:focus-visible` 绘制 `3px` `focus-ring` 外框（偏移 `2px`），输入框改用内晕。
- 常规过渡用 `--ease`（`0.15s`），弹窗/抽屉/开关滑块用 `--ease-spring`（`0.16–0.38s`）。
- 只有正在变化的状态才循环闪烁：启动中、停止中、控制台连接中的圆点以透明度呼吸；运行中是稳态，圆点保持静止。加载旋转圈保持转动。
- `prefers-reduced-motion` 关闭入场动画、状态点闪烁和过渡动画，仅保留加载旋转圈。

### 响应式

- 总览服务器列表使用容器查询（`@container servers`）：宽 `≤820px` 时单行拆成「图标+名称 / 状态 / 操作」三层堆叠；`≤520px` 时操作按钮平分整行。
- 长表单通过 `.page` 容器查询在 `≥900px` 时分两列（`.form-columns` / `.config-groups`），窄屏按 DOM 顺序单列堆叠。一键部署的五个核心选择块在表单列 `≥640px` 时排成一行，更窄时为 3+2，不出现 4+1。
- 联机页复用一键部署双栏布局（`deploy-layout` + `deploy-guide`）：主列按任务顺序排列（总开关 `OpenSwitch` → 有序步骤 `JoinSteps` → 高级设置折叠面板），说明列只放排障与原理；任何跳过会导致联机失败的条件留在主列对应控件旁。说明列可关闭（`is-guide-closed`），偏好存 `localStorage`。
- 原生 `<select>` 的 `<option>` 强制设不透明 `surface-raised` 底色与 `label` 文字，避免 Windows 暗色模式下系统下拉菜单继承半透明 `input-bg` 变灰白字。
- `≤1024px`：侧栏变为顶栏下的抽屉，顶栏按钮隐藏文字标签，实例页头部显示「‹ 实例总览」返回链接；滚动后顶栏标题胶囊显示实例名。
- `≤768px`：底部出现毛玻璃 tab 栏，弹窗转为底部抽屉，按钮铺满行宽；导入模式切换器隐藏图标；备份行内嵌的下载与还原按钮收拢进 `⋯` 菜单。
- `≤560px`：定时备份控制条的「修改计划」与开关落到对齐的第二行；主机资源条变为单列。
- `≤480px`：页头和实例操作按钮平分整行；实例页签隐藏图标并降为 `text-small`，保证英文五项在 375px 宽下也能一行放下。

### 无障碍对比度

`label`、`label-2`、`ok`、`warn`、`danger`、`accent-text` 和 `on-accent` 组合在明暗双主题下（含 `11–16%` 语义淡底叠加 `bg` 或 `surface`）均达到 4.5:1。强调橙白字在填充上亮色 4.9:1、暗色 4.6:1；`accent-text` 在 `bg` 上为 5.4:1 / 8.0:1，在 13% 淡底上最低 4.5:1 / 6.1:1。暗色面板改成石墨灰后，红字在红色淡底上最紧，为 4.8:1。修改任何色值变量时必须复检所有淡底场景（状态胶囊、`btn-ok`、`btn-danger`、`btn-tinted`、提示条）。

以下组合低于 4.5:1，禁止扩大使用范围：`label-3` 作占位字，亮色在白底输入框和 `surface` 上约 3.3:1，暗色在输入框上约 2.4:1、在 `surface` 上约 2.8:1；白色任务图标在 `c-green` 底上约 2.0–2.2:1。排队中任务的图标在琥珀底上改用深色字形（≥8:1），不用白色。

## 图标

- 统一使用 `lucide-react`（2px 描边、圆角端点、继承 `currentColor`），不混用其他图标集或 emoji。
- 尺寸：导航 `17px`，按钮 `14–16px`，菜单 `16px`，文件与备份行 `18–20px`，空状态 `28–30px`，拖拽区 `28px`。
- 导航图标和菜单图标用 `label-2`；导航选中项的图标和文字用 `label`，底色是 `select-fill` 浅灰。空状态、首次添加入口、拖拽区的圆形图标用 `fill` 底配 `label-2`，不带强调色。
- 品牌图标为 `BrandMark`（[`components/BrandMark.tsx`](../apps/web/src/components/BrandMark.tsx)），提供 `24`、`32`、`84px` 三档；需要配名称时放在 `.brand-title` 里并排。

## 组件速查表

所有类名定义在 `apps/web/src/styles.css`，方括号内为对应 React 封装组件。

| 组件 | 类名 | 规则与说明 |
|---|---|---|
| 按钮 | `btn` + `btn-primary` / `btn-tinted` / `btn-plain` / `btn-ok` / `btn-danger` / `btn-destructive`；尺寸 `btn-sm`、`btn-lg`、`btn-icon`、`btn-block`；`link-button` | 方形圆角（`radius-sm` / `.btn-sm` 用 `radius-xs`）。默认按钮是白底加 `--btn-edge` 细边（macOS 按钮样式）；带色变体和 `btn-plain` 清除细边，列表里设成透明底的行内按钮也要一并写 `--btn-edge: none`。每个视图只放一个 `btn-primary`；`btn-plain` 用 `label` 色；`btn-destructive` 仅用于不可逆确认框。`link` 和 `link-button` 用正文色加下划线，不用强调色 |
| 快捷芯片 | `chip`、`chip-mono`、`chip-desc`（置于 `quick-cmd-bar`、`jvm-memory-tiers`） | 方形小圆角（`radius-xs`），用于控制台快捷命令、内存预设等。选中的预设像分段控件的滑块一样抬起成白底细边，不染色 |
| 分段控件 | `segmented`、`segmented-item`（`active`） | 方形圆角托盘（`10px` 外框 + `7px` 选中块），用于同一内容的并列视图切换（筛选、导入方式、联机模式） |
| 实例页签 | `hub-tabs`、`hub-tab`（`active`） | 紧凑凹槽托盘（`fill` 底、`radius-sm`），当前项抬起为 `surface-raised` 实色块（`radius-xs`），图标和文字用 `label`；不画通栏底线或下划线，超出宽度横向滚动 |
| 顶栏按钮组 | `toolbar-group`、`toolbar-button`、`toolbar-badge` | 悬浮毛玻璃胶囊，`≤1024px` 隐藏文字标签 |
| 顶栏标题 | `toolbar-title` | `42px` 高毛玻璃胶囊，页面向下滚动后浮现 |
| 侧边栏 | `sidebar`、`sidebar-brand`、`nav-section`、`nav-item`（`active`）、`sidebar-footer`、`sidebar-settings`（`active`） | `≤1024px` 转为抽屉。导航是一列，不分组、不加分组标题；当前页是 `select-fill` 浅灰底，不用强调色。底栏保留用户名、面板设置齿轮和退出登录两个图标按钮，保证英文用户名不被挤断 |
| 面板设置分组 | `settings-page`、`settings-section`、`settings-section-head`、`settings-section-body` | 仅用于面板设置页。宽 `≥820px` 时左侧 `200px` 为组名与范围说明，右侧最大 `720px` 为内嵌分组容器；窄屏上下堆叠 [`SettingsPage`] |
| 面板设置行 | `settings-row`、`settings-row-notes`、`settings-row-select`、`settings-load-error`、`settings-info`、`settings-path`、`settings-path-row` | 仅用于面板设置页：左侧名称与说明，右侧单个即时生效控件（无保存条）。多行说明加 `settings-row` 使控件顶对齐；只读地址/路径用 `dl` 与等宽字体支持一键全选 [`SettingsPage`, `SessionDurationRow`, `DownloadSourceRow`] |
| 面包屑 | `breadcrumbs`、`breadcrumb-item`、`breadcrumb`、`breadcrumb-sep` | 当前层级带 `aria-current="page"` |
| 表单字段 | `field`、`field-help`、`field-warn`、`error`、`input`、`input-row`、`grid grid-2` | 白底细边输入框（`input-bg` + `field-edge`），校验失败标 `aria-invalid`，细线换成红色描边并在下方显示 `error`。使用 `Field` 或 `useFieldFeedback`（失焦或提交触发后才显错，随后随输入实时更新）。数字一律用 `NumberInput`（不用 `type="number"`），密码用 `PasswordInput`，带后缀或按钮用 `input-affix` + `--affix-space` |
| 开关与复选框 | `switch`（`role="switch"`）、`checkbox-field` | 独立开关即时保存；复选框随表单提交。带保存条的配置列表（`server.properties`）里开关随保存条一起提交 |
| 分组容器与表单 | `card`、`form-card`、`page-section`、`section-header`、`section-title`、`count-badge`、`form-section-title`、`step-badge` | 表单分组继续写 `card form-card`：渲染为内嵌实色容器（`surface` + `1px panel-border` + `radius-md`），标题在容器外上方；嵌套在其内部的 `.list-group` 降级为 `fill-2`。不加毛玻璃和彩色侧边条。`step-badge` 用 `fill` 底配 `label-2`，只给真正有先后的步骤 |
| 分组列表 | `list-group`、`list-row`、`list-row-text`、`list-row-title`、`list-row-desc`、`list-row-control`、`list-row-value` | 内嵌实色容器（`surface` + `1px panel-border` + `radius-md`），行内边距 `12px 18px`，行间细线从 `18px` 内缩开始 |
| 折叠面板 | `details.disclosure` | 仅用于高级选项 |
| 导入来源列表 | `import-dir-row`、`import-dir-path`、`import-source-head`、`import-source-list list-group`、`import-source-option list-row`（`is-unavailable`）、`import-source-reason` | 仅用于本地目录导入：先展示可复制路径，再以整行单选列表展示候选目录，不可用项禁用并用 `warn` 标明原因 [`ImportsSourceSection`] |
| 识别摘要 | `import-summary`、`import-summary-row`、`import-summary-note`、`import-summary-warn` | 仅用于导入配置：两列摘要展示已识别的服务端、Java、内存，背后控件收在 `disclosure` 里，异常项自动展开 |
| 二维码 | `qr-code`（置于 `remote-qr`） | 明暗双主题均保持白底黑码加留白边距，由 `QrCode.tsx` 绘制内联 SVG |
| 可复制值 | `direct-address`、`direct-command`、`remote-url`、`remote-join-value` | 等宽字体加 `user-select: all`，统一调用 `clipboard.ts` 的 `copyText()` |
| 悬浮操作条与保存条 | `action-bar`、`action-bar-status`、`action-bar-check`、`save-bar`、`save-bar-slot` | 每页最多一条，吸底悬浮。编辑已有配置（实例设置、参数配置）用 `SaveBar`：未改时隐藏，修改后显示未保存项数、放弃修改与保存，运行中保存后提示重启并提供重启按钮；新建流程（一键部署、导入）常驻显示，可内含一条必选同意项（如 EULA） |
| 提示条 | `callout` + `callout-info` / `callout-success` / `callout-warning` / `callout-danger`、`callout-icon` | `callout-info` 和不带修饰的提示条用中性灰，警告用琥珀黄。只写出了什么问题和下一步做什么。持续存在的先决条件（如 Windows 管理员权限）用列表行加状态胶囊和按钮，不用提示条；带后果的操作放进 `ConfirmDialog`。正文用 `label`，仅 `<strong>` 使用 `danger` |
| 就绪提示条 | `ready-strip`、`ready-strip-icon`、`ready-strip-text` | 服务器就绪后控制台上方单行提示：仅图标和 9% 淡底用绿色，配邀请按钮和关闭按钮 [`ReadyHint`] |
| 状态胶囊 | `status-pill` + `running` / `stopped` / `starting` / `stopping` / `crashed` / `warning`、`status-dot` | 保留 `radius-pill`，圆点加状态词 [`StatusPill`, `InstanceStatusPill`] |
| 进度与加载 | `progress`、`progress-fill`、`task-progress`、`spinner`、`spinner-sm`、`page-loading` | 后台任务持续显示到已完成或失败 |
| 空状态 | `empty-state`、`empty-icon`、`empty-actions`、`empty-state-compact` | 标题 + 下一步说明 + 主按钮；坐落在统一内嵌实色容器上 |
| 任务卡片 | `task-card status-<status>`、`task-card-head`、`task-card-icon`、`task-card-message`、`task-card-error`、`task-card-foot` | 位于 `task-drawer` 内 [`TaskCenter`]。`status-cancelled` 用中性灰不标红；顶栏角标只统计进行中的任务 |
| 用量条 | `meter`（`is-neutral` / `is-warning`）、`meter-fill` | `4px` 装饰性进度条，旁边必须同时展示数值 [`Meter`] |
| 主机资源条 | `host-strip`、`host-meters`、`host-meter`、`metrics-status` | 展示本机 CPU、内存与数据盘，直接落在底布上不套容器，视觉权重低于服务器列表；`≤768px` 移到列表下方 [`HostMeters`] |
| 服务器列表 | `server-section`、`server-list`、`server-row`、`server-id`、`server-state`、`server-sentence`（`is-warn` / `is-danger`）、`server-figures`、`server-actions`、`server-next-quiet` | 内嵌实色容器，借助 `subgrid` 对齐各列；整行可点击进入实例，需要处理的实例排在最前；列表没有可见标题，由页面标题和状态句引出。状态胶囊后只在有胶囊没说的信息时跟一句话（为什么启动不了、还在加载世界），并前置对应按钮，行间细线从名称列开始；桌面端启停、更多和「邀请玩家」（`server-next-quiet`）默认无底色，悬停显现，只有解决问题的按钮带浅色底 |
| 总览状态句 | `overview-status`、`overview-status-issues` | 22px 副标题句（如「6 个实例，2 个运行中」），需要关注的实例数用 `danger` 跟在后面 |
| 首次添加入口 | `start-paths`、`start-path-list`、`start-path` | 空总览页的三种添加方式，包在统一内嵌实色容器里，整行可点 |
| 文件列表 | `files-toolbar`、`file-list list-group`、`file-row`、`file-main`、`file-icon is-dir|is-file` | 内嵌实色容器，分隔线对齐文件名列起点 [`FilesTab`] |
| 备份页 | `backups-toolbar`、`backups-schedule`、`backups-list-section`、`backup-list list-group`、`backup-row`、`backup-source`、`backup-actions` | 顶部工具栏停服不挂说明句、运行中仅显示「还原需先停服」状态标签；下方为单行定时备份控制条（正常完成不占第二行，仅失败时展开 `callout-danger`），接着是带数量徽章与总占用的备份列表容器，每行用来源徽章区分类型，桌面端行内露出下载和还原按钮，`≤768px` 收进 `⋯` 菜单 [`BackupsTab`, `BackupScheduleSection`] |
| 品牌与核心图标 | `brand-mark brand-mark-<size>`、`core-icon core-<type>` | [`BrandMark`, `CoreIcon`] |
| 弹出菜单 | `action-menu-trigger`、`action-menu-panel`、`menu-item`（`is-danger`） | 通过 Portal 挂在 `<body>` 下固定定位，避免被容器 `overflow: hidden` 裁切 [`ActionMenu`] |
| 弹窗 | `confirm-dialog`、`confirm-dialog-panel`、`confirm-dialog-title` / `-body` / `-footer` | 原生 `<dialog>`，`≤768px` 转为底部抽屉 [`ConfirmDialog`] |
| 气泡面板 | `popover`、`appearance-*`、`accent-*`、`language-options` | [`ThemeToggle`, `LanguageToggle`] |
| 控制台 | `console-window`、`console-header-bar`、`console-status`、`console-tool`、`console-output`、`console-input-bar` | 始终深色；`≤768px` 输出区预留底部输入框与底栏高度，改动实例头部或页签高度时必须在 `390×844` 复检 [`ConsolePanel`] |
| 拖拽上传区 | `drop-zone`（`is-dragging`、`has-file`、`is-disabled`） | 位于 `field` 内 |

## 新页面开发清单

1. 页面骨架：`.page` 内依次放 `.page-header`（`PageHeader`：大标题、副标题、右侧操作）与 `.page-section` 区块。表单页将主提交动作放在 `.action-bar` 或 `SaveBar` 中并用 `<form>` 包裹，主按钮用 `type="submit"`，其余按钮显式写 `type="button"`。
2. 优先复用上述组件类；重复出现的新值写入 `styles.css` 的 `:root` 与暗色变量块。
3. 所有文案写入三种语言表，完成后在亮色/暗色、三种语言以及 `375px` 窄屏下检查加载中、空状态、报错、禁用和键盘聚焦态。
4. 对照下面的防模板化清单检查真实截图，不只看代码。
5. 主按钮在输入未通过校验前保持禁用（复用 `apps/web/src/validation.ts`，服务端仍独立复验）；未输入过之前不提前报空值错，首次输入过程中不打断。点击即置忙态，防止双击重复提交。

## 防模板化检查

如果某个样式或文案换到任何别的产品里你也会照搬，那它就是模板套路。上线前逐条核对，只有能说清它给用户提供了什么信息才保留：

- **结构**：不要为了凑齐一排把数据切成孤立的统计卡片；不要在容器里再套同级带边框容器；非步骤内容不加 `01 / 02 / 03` 编号；能用一句话说清的状态不拆成大字配小字统计砖；禁止装饰性渐变。
- **排版**：不在标题里给单个词斜体或上色；不用全大写加宽字距的小标签；不在标题上方再叠一层重复标题的小字；字号只用八档变量；等宽字体只用于日志、命令、代码和路径。
- **视觉元素**：中点（`A · B`）只用于**同类元信息**之间（体积、时间、数量、版本、路径），不把标签与状态、数值与备注用中点硬拼；按钮和链接文字后不加装饰性 `→`（表示点击路径的除外）。
- **色彩**：强调橙只用于主操作、打开或勾选的控件、焦点和进度，不做装饰色；橙色不用于状态和警示；不引入未定义在变量里的杂色。
- **动效**：不给每个区块加无意义入场动画，也不给不可点击的普通列表行加多余悬停位移；动效只响应真实操作并遵守 `prefers-reduced-motion`。
- **文案**：禁止营销废话和页面顶部的常驻解释句；报错不空道歉，只给原因和出路；同一流程中同一个动作只用一个名称。

每页只在一处用力，其余保持安静；收尾前再拿掉一样东西。
