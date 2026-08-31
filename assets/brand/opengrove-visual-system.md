# OpenGrove Visual System

## 核心方向

OpenGrove 的视觉应该像一个安静、可靠、面向开发者和知识工作的 agent workspace。整体关键词：

- 低饱和
- 强留白
- 轻边框
- 统一线性图标
- 圆润但克制
- 字体层级清晰
- 品牌绿色只做识别，不到处抢视觉

这套方向不是把界面变白一点，而是把规则收束：少颜色、少边框、少装饰，用一致的排版、间距、控件和图标建立现代感。

## 品牌资产

### Wordmark

主字标使用 `OpenGrove`，其中 `Open` 使用 graphite，`Grove` 使用 green。

- 主文件：`opengrove-wordmark.svg`
- 预览文件：`opengrove-wordmark-on-light.svg`
- 用途：启动页、关于页、设置页顶部、README、官网/文档
- 不建议：放进每个小按钮、每条列表项或重复出现在侧边栏中

### Sapling Mark

像素小树作为形象 logo，只用于需要小尺寸识别的地方。

- 主文件：`opengrove-sapling.svg`
- 预览文件：`opengrove-sapling-on-light.svg`
- 用途：favicon、app icon、侧边栏 workspace icon、空状态插图里的小标识
- 不建议：替代所有功能 icon，或与 provider/kernel 图标混用成彩色装饰

## 颜色系统

### Primitive Tokens

```css
:root {
  --og-white: #ffffff;
  --og-canvas: #fbfbfa;
  --og-app-bg: #f6f6f7;
  --og-surface: #ffffff;
  --og-surface-subtle: #f2f3f3;

  --og-text: #1f2023;
  --og-text-strong: #111827;
  --og-text-muted: #6f7278;
  --og-text-soft: #9a9da3;

  --og-border: rgba(0, 0, 0, 0.08);
  --og-border-strong: rgba(0, 0, 0, 0.12);

  --og-accent: #2f95f3;
  --og-accent-soft: #e8f3ff;

  --og-green: #168a53;
  --og-sapling-green: #5fb24a;
  --og-sapling-highlight: #7bcb57;
  --og-sapling-shade: #43a343;
  --og-sapling-trunk: #202424;
}
```

### 使用规则

- 页面背景：`--og-app-bg`
- 主内容画布：`--og-surface`
- 普通文字：`--og-text`
- 说明文字：`--og-text-muted`
- 分割线和卡片边框：`--og-border`
- 交互强调：优先用 `--og-accent`
- 品牌识别：只在 logo、app icon、品牌入口使用绿色
- 状态色：减少彩色 pill，优先用灰底标签；危险/警告色只在确实需要时出现

## 字体层级

系统字体栈：

```css
font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", sans-serif;
```

建议层级：

- 页面标题：`26px / 600 / line-height 1.2`
- 页面说明：`15px / 400 / line-height 1.55`
- 分区标题：`16px / 600 / line-height 1.35`
- 正文：`14px / 400 / line-height 1.5`
- 辅助说明：`12-13px / 400 / line-height 1.45`
- 按钮文字：`13-14px / 500`

原则：

- 少用超粗字重，标题 600 足够。
- 中文说明文字不要太黑，统一落在 muted 灰度。
- 卡片内部不要使用 hero 级字号。

## 图标系统

- 功能 icon 统一使用 lucide。
- 常规尺寸：`16px`
- 导航尺寸：`18px`
- 圆形按钮内部 icon：`18-20px`
- 线宽统一：`stroke-width: 1.8`
- 默认颜色：`--og-text-muted`
- 激活颜色：`--og-text`
- icon 容器：`28px` 或 `32px`，不要混用过多边框/底色

品牌 icon 和 provider/kernel icon 可以保留彩色，但只在身份识别场景出现。

## 布局规则

### 应用框架

- app 背景使用浅灰：`--og-app-bg`
- 主内容使用大白色画布，圆角 `24px`
- 侧边栏保持浅灰，降低视觉重量
- 顶部按钮和导航使用轻量 pill
- 不用多个浮动卡片堆出页面骨架

### 设置页

设置页参考截图第三张：

- 左侧窄设置导航
- 右侧内容固定宽度 `960-1040px`
- 表单用轻列表行，不用大卡片堆叠
- 每行：左侧标题/说明，右侧控件
- 分区之间靠留白和细分割线，而不是重描边容器

## 组件规则

### Switch

- 所有“启用/禁用”统一使用 switch。
- on 使用 `--og-accent`
- off 使用中性灰
- 不再用文字按钮表达启用状态，除非是安装/修复类动作

### Segmented Control

- 用于模式切换、周期切换、视图切换
- 背景浅灰，选中项白底或更浅底
- 文字小而稳，不用强描边

### Button

- 主按钮：深色或 accent，根据页面语境控制数量
- 次按钮：白底 + 轻边框
- 图标按钮：圆形或 pill，优先 icon-only，hover 显示 tooltip
- 不把普通状态 pill 做成按钮

### Card / List

- 卡片只用于真正的独立对象，例如 kernel/provider 条目
- 卡片圆角建议 `12px`
- 描边 `--og-border`
- hover 只轻微变背景或边框，不做重阴影
- 找到/未找到的条目高度一致，状态通过灰度、按钮和说明表达

## 页面落地顺序

1. 更新 `tokens.css`、`base.css`：颜色、字体、圆角、阴影、focus ring。
2. 更新 shell/sidebar/topbar：浅灰 app 背景 + 大白画布 + 统一导航 pill。
3. 更新 settings：左侧导航、右侧列表行、switch、segmented control、按钮。
4. 更新 kernel/provider cards：统一高度、统一 icon 容器、减少彩色状态。
5. 更新 chat/composer：输入框、工具按钮、消息区留白和图标规则。
6. 更新 knowledge 列表：轻列表风格，减少卡片边框和过多状态色。

## 不做什么

- 不做满屏绿色主题。
- 不用渐变、光斑、装饰球或大面积插画。
- 不把 sapling icon 到处当功能图标。
- 不为每个状态发明不同颜色。
- 不让卡片嵌套卡片。
- 不把所有控件都做成 pill，只有导航、标签、segmented control 适合 pill。

## 一句话标准

打开 OpenGrove 时，第一眼应该是安静、干净、可信；第二眼才看到像素小树和绿色字标带来的记忆点。
