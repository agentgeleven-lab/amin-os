# Amin UI v2

所有应用沿用用户选定的主题配色，使用同一套布局、控件和反馈规范。OS 主窗口与楼层窗口都以 `.amin-ui` 为应用边界；世界状态 iframe 加载同一 `standard.css`，外观服务同步主题变量。

## 页面结构

窗口负责应用名、返回和收起。页面按「当前上下文 → 可选标签页 → 操作 → 内容」排列，避免重复应用大标题。一般应用使用外层 pane 或楼层 body 作为唯一主滚动区；页面本身自然伸展。地图画布和世界状态 iframe 保留各自的专用布局。

```html
<section class="amin-app-page">
  <div class="amin-context"><strong>当前聊天</strong><span>数据作用范围</span></div>
  <nav class="amin-tabs" role="tablist" aria-label="应用页面">
    <button type="button" role="tab" aria-selected="true" aria-controls="example-content">查看</button>
  </nav>
  <div class="amin-toolbar">
    <button type="button" class="amin-primary">主要操作</button>
    <button type="button">次要操作</button>
  </div>
  <p class="amin-notice" role="status" aria-live="polite"></p>
  <section id="example-content" class="amin-card">
    <div class="amin-section-heading"><h3>检定设置</h3><span class="amin-meta">本次行动</span></div>
    <div class="amin-form-grid">
      <label class="amin-field">名称<input type="text"></label>
      <label class="amin-field">规则<select><option>D20</option></select></label>
      <label class="amin-field amin-span-full">说明<textarea></textarea></label>
    </div>
  </section>
</section>
```

这是结构示例；事件、键盘切换、`aria-selected` 和 `aria-controls` 仍由应用真实实现。操作按钮用 `type="button"`；提交按钮明确使用 `type="submit"`。主操作使用 `.amin-primary`；普通按钮默认次要样式。主操作每个区域通常保留一个。

## 有状态操作

会修改聊天状态的页面统一按以下顺序组织：

1. 编辑字段，并保留当前聊天 / 当前分支说明。
2. 用“预览”建立待确认结果，结果卡使用 `.amin-result`，同时显示对象、原因及业务前后值。
3. 在结果卡中明确“确认一次”和“取消预览”。确认前如果聊天、回复候选或依赖数据变化，作废旧预览。
4. 保存成功后显示具体完成信息；保存失败时保留已经应用的结果，停用新的写入，并只提供“重试保存”。

“重试保存”的说明必须指出它不会再次消耗、转交、旅行、推进时钟、掷骰或发动。共享聊天元数据正在保存时，其他应用的提交按钮保持禁用或返回明确忙碌提示；读取、筛选和复制不必因此隐藏。

骰点的“本地掷骰”“追加固定结果到草稿”和酒馆发送是三个动作。能力检定还把“确认检定后的效果”作为单独动作。页面按钮和反馈不得暗示插件会调用 `/roll` 或自动发送消息。

上下文文字使用实际范围：人物卡、背包与关系显示“当前聊天 / 当前分支”；跨应用存档说明“恢复到当前聊天末尾”；能力库等全局资料明确“跨聊天共享”。楼层按钮所在的消息不等于这些应用的历史快照。

## 组件契约

| 类名 | 作用 |
| --- | --- |
| `amin-app-page` | 自然伸展的页面，统一内边距和纵向间距 |
| `amin-context` | 简短上下文与数据归属，底部分隔线 |
| `amin-tabs` | 紧凑横向标签页，窄屏换行 |
| `amin-toolbar` / `amin-inline` | 可换行操作行 / 可换行内联内容 |
| `amin-stack` | 统一间距的纵向内容 |
| `amin-card` | 中性内容卡片，使用当前主题背景和边框 |
| `amin-section-heading` | 紧凑分组标题，可在右侧放元数据或操作 |
| `amin-form-grid` | 双列表单；窄容器和手机单列 |
| `amin-field` | 标签文字与满宽输入控件 |
| `amin-check` | 复选框与可点击文字的一行布局 |
| `amin-span-full` | 跨越表单所有列 |
| `amin-meta` / `amin-help` | 次要文字或补充说明 |
| `amin-empty` | 空内容说明；保留可操作的下一步 |
| `amin-result` | 结果卡片，侧边使用主题强调色 |
| `amin-notice` | 进度、错误或完成反馈；空内容时隐藏 |
| `amin-scroll` | 仅供专用 flex 布局中明确的主内容区使用 |

`.amin-app-card` 是桌面启动磁贴的旧类名，不能用于应用内容卡片。除 `.amin-app-page` 外，组件不加 `app-` 前缀。

反馈可使用 `data-state="busy|error|success"`，同时提供文字说明；不能仅靠颜色表达状态。生成期间使用 `disabled` 和 `aria-busy`，保留取消操作。错误应给出具体原因和可执行下一步。不要用透明度隐藏说明。

## 主题与样式归属

配色读取 `--amin-bg/card/control/text/muted/line/accent/ink`；强调色文字可使用 `--amin-accent-text`。字号、圆角、间距读取 `--amin-font/radius/gap`。主按钮前景使用 `--amin-ink`。业务应用不得写死深色背景、独立主题或 `color-scheme:dark`。

- `base.css`：默认变量、主窗口结构和普通 pane 滚动。
- `ui.css`：既有地图、状态和回复嵌入结构，旧 UI 的最少适配。
- `settings/appearance.css`：主题表面、品牌、楼层框架和宽高规则。
- `metro.css`：桌面磁贴与独立 Windows 桌面风格。
- `ui/standard.css`：表单、按钮、语义布局、反馈和窄屏规则，最后加载。
- `ui-status.css` 与 `settings/appearance-frame.css`：iframe 的结构和主题同步。

旧宿主表单样式需要有边界的 `!important`；新的布局优先添加语义类，不再新增高优先级 ID 覆盖。全局变量仅在默认根或外观服务中定义，各应用保留自身主题覆盖。

## 手机与滚动

布局按实际应用容器响应，540px 以下的表单单列；手机视口 640px 以下执行相同规则。320 / 390 / 430px 宽度不能出现页面横向滚动。控件允许文字换行；工具栏、页签和楼层入口自然换行，不能裁掉功能。

手机或粗指针设备的按钮、输入控件和复选标签至少 44px 高。手机文本输入至少 16px，避免聚焦时浏览器自动缩放；其余文字继续尊重主题字号。页面内不要设置固定桌面宽度。

楼层应用在手机上使用消息可用宽度，覆盖保存的桌面像素宽度；高度读取 `--amin-floor-height`，由楼层设置选择桌面或手机值。主窗口位置由 shell 根据 visualViewport 计算，打开手机主窗口后隐藏浮动启动器。窗口头部保留关闭按钮。

大段原文、JSON 和受限选择列表可以有独立滚动；普通卡片列表和整个表单不应再套第二层主滚动区。iframe 页面必须自己加载统一样式，不能依赖父文档 CSS 穿透。

0.13 页面沿用这些规则：

- 人物卡的筛选、人物选择、绑定字段与检定参数在窄容器中转为单列。
- 背包的物品 / 资源 / 账本标签页允许换行；前后值和双方账目在卡片内换行。
- 人物关系 SVG 使用独立 overflow 容器，不能撑宽整页；图下保留完整文字列表和键盘可操作入口。
- 场景旅行把目的地选择、方式、耗时和确认原因放入共享表单；预览卡列出时间前后、抵达场景与到期效果。
- 跨应用存档的模块列表、差异路径和 JSON 输出允许断行；JSON 文本区可独立滚动，恢复确认仍留在正常页面流中。

以上结构由共享 CSS 提供 44px 粗指针控件和窄屏单列。0.13 最终使用 Headless Edge 与隔离的模拟 SillyTavern 完成 9 组功能检查及 23 份 1280 / 320 / 390 / 430px 布局快照，页面和 pane 未出现横向溢出，运行时错误为 0。手机结果来自桌面 Edge 的手机视口，物理手机触控和软键盘仍需单独验证。

## 验收

检查全部主题及应用独立主题，圆角 0 / 24、字号 11 / 20、紧凑 / 舒适间距。检查桌面和 320 / 390 / 430px 手机宽度的标题、按钮、字段、标签页、空状态及长结果。键盘焦点应清楚，输入后不能跳焦点；窗口收起与打开不应遮住发送区。

验证生成、取消、切换、保存失败重试和各应用核心操作。对 0.13 还要检查人物绑定值变化、背包双边账目、关系图与完整列表、能力检定固定值、限时到期、旅行联合预览、存档恢复前备份和导入只收纳不恢复。最终 `npm run check` 覆盖 285 个 JavaScript 模块，`npm test` 为 832 / 832。模拟 DOM、模拟宿主浏览器、真实酒馆和真机结果需要分别说明验证范围。
