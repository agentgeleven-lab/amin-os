# Amin UI v1

所有 OS 应用统一使用 `standard.css`，不要复制独立主题。Shell 为每个应用容器自动加上 `.amin-ui`；外观服务按 `data-app` 注入全局或应用覆盖变量。

## 页面结构

OS 负责品牌、返回按钮和单行应用标题。应用内部按「上下文行 → 可选标签页 → 操作区 → 内容 → 可选保存栏」排列，不重复大标题或宣传语。地图画布、状态字段、回复候选保留各自业务布局。

```html
<section class="amin-ui">
  <div class="amin-context">当前对象或操作说明</div>
  <div class="amin-tabs" role="tablist" aria-label="应用页面">
    <button role="tab" aria-selected="true" aria-controls="example-content">查看</button>
  </div>
  <div class="amin-toolbar">
    <button class="amin-primary">主要操作</button>
    <button>次要操作</button>
  </div>
  <div class="amin-notice" role="status" aria-live="polite"></div>
  <section id="example-content" class="amin-card">内容</section>
</section>
```

这是结构示例：应用需实现真实的切换事件、键盘导航及状态更新。按钮默认次要样式；主要操作加 `.amin-primary`；禁用用 `disabled`，选中用 `aria-selected` 或 `aria-pressed`。不要用透明度隐藏提示文字。

## 外观契约

配色只使用 `--amin-bg/card/control/text/muted/line/accent/ink`。字号、圆角、间距使用 `--amin-font/radius/gap`。主按钮文字必须使用 `--amin-ink`。正文采用统一系统字体，品牌单独保留 Courgette。不得写入固定深色背景、独立字号或 `color-scheme:dark`。

每个应用只保留一个主要内容滚动区域；工具栏可换行，不压缩文字列。iframe 需加载同一标准文件，并由外观服务同步变量；不要假设父文档 CSS 能穿透 iframe。现有状态应用提供示例。新增应用还需在外观服务的应用列表中注册。

兼容旧插件的选择器集中在 standard.css 的 adapters 区域。旧宿主规则通过有边界的 `!important` 覆盖；新应用直接使用语义类，不再新增高优先级 ID 样式。

## 验收

检查全部六种主题、应用独立主题、圆角 0/24、字号 11/20、紧凑/舒适间距；检查桌面和 390px 手机宽度下的标题、换行和滚动。验证生成、取消、切换候选、保存等业务功能。预览使用模拟聊天，不能替代真实酒馆验证。
