# 场景与时间

将当前剧情的游戏时钟与场景资料放在同一应用。首次打开只读取数据；未设置的时间、人物、天气与物件保持未知。

## 使用

- 在「时钟」填写起始日期、时间与原因，预览准确结果后确认。日期使用公历月长和闰年；历法名称可以自定义，暂不支持自定义月长。
- 用分钟、小时或休息按钮预览推进；确认一次只提交一个时间事件。休息仅推进时间，不结算生命、物品或持续效果。
- 在「场景」保存名称、在场人物、环境、场景物件和其他已确认资料。保存资料与进入场景是两个动作；也可选择「保存并进入」。返回场景会沿用该处已保存的资料，游戏时间仍保持当前故事时刻。
- 地图引用保存 `mapId/nodeId`，可明确选择引用地图当前位置；不创建地图、移动角色或同步背包。未发现地点不出现在地图候选中。
- 「设置」可以编辑时段边界，并开启模型读取。默认不注入；启用后只注入当前时钟与当前场景的已保存字段。
- 所有变更先预览再确认。保存失败时选择「重试保存」，沿用同一条事件，不再次推进时间。

## 存储与分支

聊天元数据 `amin_os_scene_v1` 的 `events` 保存明确操作，每条包含唯一 ID、真实保存时间 `at`、操作原因、游戏时间前后值、场景状态快照和消息候选路径。游戏时间与真实保存时间分开保存。

路径是消息名称、用户标志、正文和 `swipe_id` 的完整前缀证据。读取时只恢复与当前聊天路径匹配的快照；因此重新打开、复制到较早分支、删楼层、编辑正文或切换候选不会把后续场景状态误作过去事实。空聊天操作以空前缀作为故事起点；后续分支继承这类起点事实。读取不修改消息，不改写旧快照，也不自动记录模型轮次。

本应用没有跨模块总存档承诺。旧消息被编辑或候选被重新编号时，无法匹配的记录会被排除，应由用户重新确认当前事实。每个聊天最多 100 个场景、2000 次明确操作；不会静默丢弃旧记录。完整快照和路径会增加聊天元数据体积。

## 中央接入契约

```js
import { mount } from './apps/scene/view.js';
import { getSharedSceneService } from './apps/scene/service.js';
import { currentPrompt, readCurrentScene, formatGameTime } from './apps/scene/model.js';

const view = mount(target); // 返回 { open(), dispose() }，兼容 OS 和楼层窗口
const service = getSharedSceneService(() => SillyTavern.getContext());
const prompt = currentPrompt(SillyTavern.getContext());
// view.open() 重新读取当前聊天；view.dispose() 清理这一个窗口。
// 中央层负责初始化共享服务，并把非空 prompt 接入共享 AI 的当前上下文。
// 读取异常由中央层沿用其他模块的可见错误报告；不要静默放入旧缓存。
```

`mount` 使用 UI v2 的 `amin-page/amin-app-page/amin-card/amin-context/amin-tabs/amin-toolbar/amin-form-grid/amin-field/amin-check/amin-result/amin-meta/amin-empty`；主题颜色、控件尺寸、窄屏单列和触摸尺寸由共享 `ui/standard.css` 提供，不需要新颜色样式。

纯读取 `readCurrentScene(ctx)` 返回：

```js
{
  version: 1,
  clock: null, // 或 { year, month, day, hour, minute, calendarLabel }
  periods: [{ name: '深夜', startMinute: 0 }],
  scenes: {
    // [id]: { id, name, participants, weather, objects, notes,
    //         mapId, nodeId, updatedAt, gameTime }
  },
  activeSceneId: null,
  settings: { enabled: true, includeInContext: false }
}
```

`formatGameTime(clock, periods?)` 返回展示文本，空时钟返回「未设置游戏时间」。剧情档案可读取时钟的副本作为用户确认条目的时间来源，不写回场景模块。场景 `gameTime` 是最后确认资料的游戏时刻，切换场景不会将该值恢复到全局时钟。

共享服务自己监听宿主 `GENERATION_AFTER_COMMANDS`，用 `amin-os-scene-time` 独立提示键注入普通正文。`normal/continue` 使用当前路径；`regenerate/swipe` 在宿主尚未移除末尾 AI 回复时先截去该候选，避免用未来事实重写自身；`quiet` 和 dry run 不另加提示。完成、停止、切聊天、改楼层及状态改变时清空提示。缺少接口时本地场景管理仍可使用，服务 `supported` 为 false；中央层无需再次注册同一宿主提示。

服务公开 `capture/check` 防止异步操作跨聊天或覆盖已变化的资料；`stage(op,data,token?)` 仅建立预览，`confirm()` 一次性消费，`retrySave()` 只保存，`discard()` 取消。`read/history/mapReferences` 为当前聊天读取；`subscribe` 返回取消订阅函数。共享服务通过宿主事件和轻量轮询重新读取当前分支，关闭单个应用窗口只移除订阅，不销毁共享服务。

## 验证

`node --test test/scene-model.test.js test/scene-service.test.js`

`node apps/scene/browser-smoke.mjs` 运行独立 Edge/Chromium 数据夹具，检查真实 DOM 的预览、确认、场景进入、上下文开关、切聊天草稿清理及 390px 四页布局。可用 `AMIN_BROWSER` 指定浏览器路径。

专项测试覆盖闰日、跨年、无事实默认值、空聊天起点、复制旧分支、候选切换与回返、中间删除/编辑、切场景保留全局时间、默认不注入、地图只读、预览不写入、一次提交、保存失败重试和切聊天取消陈旧操作。真实酒馆端生成提示与存档落盘由中央集成进一步验收。
