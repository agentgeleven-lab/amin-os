# TauriTavern 兼容性与性能检查 · 0.16.3

检查对象：Amin OS 0.16.2 与本次改动；宿主为 Darkatse/TauriTavern `a1855be4a4f8b6ee7cd0374a84dbb3709c3e5375`（检查时 main）。用户反馈使用最新更新，但尚未读取其安装包的精确版本，也未在其 WebView 中采集性能轨迹。

## 结论与适配

前端兼容并不表示扩展没有性能成本。Amin 的后台检查确有随聊天文本量增长的重复序列化；本次先用同一合成样本测量，再优化这部分。

| 接口 | 检查结果 |
| --- | --- |
| 完整聊天与楼层索引 | 当前 `getContext().chat` 是完整有序历史；`api.chat.current.windowInfo()` 的起点固定为 0。保留原绝对楼层语义。 |
| 扩展加载 | 同源 third-party 资源路径兼容，普通 SillyTavern 加载方式保留。 |
| 元数据保存 | 宿主提供 `getContext().saveMetadata()` 与保存队列；Amin 继续使用公开接口。没有迁移用户数据到另一份存储。 |
| 当前酒馆完整预设 | `generateQuietPrompt` 走酒馆 Quiet 生成；会使用对应触发条件的提示词块和当前渠道。 |
| 指定连接配置 | Chat Completion profile 走宿主后端；配置中的 preset 提供生成参数，不等于完整 Prompt Manager 提示词。 |
| 不支持的 Text Completion 配置 | 在 Tauri 中根据宿主 CONNECT_API_MAP 过滤，并阻止旧配置发送；普通 SillyTavern 保持支持。 |
| 预设与渠道一致性 | 可解析类型的 profile 在发送前验证预设仍存在；有相应宿主接口时，Quiet 排队期间切换 provider/model 会取消旧请求。 |
| 有界聊天 DOM | 只把 DOM 当作可销毁投影，楼层按钮跟随 ChatSurface participant 的挂载与清理。 |
| 首次投影时序 | 新增 manifest `hooks.chatSurface` 和命名导出，等待地图、世界状态的异步楼层入口注册完成；不等待较晚的 APP_READY。 |
| 托管模式后台扫描 | 关闭 Amin 的 MutationObserver 和 `#chat .mes[mesid]` 扫描，保留合并后的业务事件通知。普通宿主保留原监听。 |

宿主 `ExtensionDEV.md` 仍有旧的“部分消息窗口”描述，与当前 `docs/API/Migration.md` 及实际代码不同。本次依据当前实现，未据旧说明修改楼层编号。

## 可复现的离线测量

环境：Windows x64、Node 24.7.0、Ryzen 7 9800X3D。每条合成消息 2048 个 ASCII 字符，无用户聊天。使用有效的最小人物、背包、关系和场景存储；分别预热 4 轮，再测量 25/20/12 轮。计时范围为四个服务的合计空闲 `sync()`。

| 消息数 | 修改前 p50 / p95 | 修改后 p50 / p95 |
| ---: | ---: | ---: |
| 100 | 0.841 / 1.320 ms | 0.015 / 0.036 ms |
| 1000 | 8.494 / 9.873 ms | 0.040 / 0.065 ms |
| 5000 | 46.347 / 71.553 ms | 0.177 / 0.348 ms |

四个服务原先约每 800ms 把完整聊天序列化一次。改为共享的内存修订检查：比较消息字段，不复制或串接全部正文；编辑早期消息、切换候选、截断、追加及切换聊天仍会失效。持久化历史格式保持原样。计时区间两版的保存次数与界面通知均为 0。

这些数字仅代表该代码路径的合成负载，不是完整酒馆的 CPU 占用、开分支耗时、帧率或提速倍数。真实聊天有更大的应用历史时，元数据解析、原生变量回放和磁盘保存仍有成本；不能承诺插件“零影响”。

复现命令（先准备对应版本源码）：

```text
node scripts/performance-audit.mjs --root <0.16.2源码目录>
node scripts/performance-audit.mjs
```

脚本输出环境、样本参数、源码摘要、p50/p95、保存与通知计数。不得并行跑前后基准，以免互相争抢 CPU。

## 验证边界

自动化覆盖消息变更检测、托管模式零 DOM 扫描、原宿主监听、启动 hook 等待异步注册及失败传播。小白变量回放测试仍单独运行。未启动用户实际 TauriTavern、未发送真实模型请求、未测 Android/iOS WebView。

独立 API 仍受 WebView 跨域、混合内容和密钥可见性设置影响；当前酒馆/Chat Completion profile 是宿主原生请求渠道。本次没有改写世界书存储流程：同时打开酒馆世界书编辑器并由插件写入时，仍需现场验证宿主待保存队列与插件写入的交错情况。长聊天下地图历史、世界状态记录、应用元数据增长及手机键盘/安全区仍应单独测量，没有在本次基准中证明它们无开销。

Quiet 渠道检查覆盖宿主提供的 source 与解析后的 model，尚不覆盖同 source/model 下的代理地址、密钥或其他参数变化。缺少对应能力的旧宿主保留原兼容路径，不猜测配置结构。

进一步现场测量应保持同一聊天与其他扩展设置，对比启用/停用 Amin 的空闲 30 秒、一次回复和一次旧楼层分支切换，记录脚本耗时、长任务、保存次数与实际完成时间。停止计时后再恢复原设置；不以 Node 测量替代这一步。

## 宿主参考

- [迁移指南：完整历史与公开保存接口](https://github.com/Darkatse/TauriTavern/blob/a1855be4a4f8b6ee7cd0374a84dbb3709c3e5375/docs/API/Migration.md)
- [ChatSurface 生命周期与启动 hook](https://github.com/Darkatse/TauriTavern/blob/a1855be4a4f8b6ee7cd0374a84dbb3709c3e5375/docs/API/ChatSurface.md)
- [宿主扩展加载实现](https://github.com/Darkatse/TauriTavern/blob/a1855be4a4f8b6ee7cd0374a84dbb3709c3e5375/src/scripts/extensions.js)


## 0.16.5：快速切聊保存保护

宿主 `APP_READY` 不等同于聊天加载完成：自动加载是异步启动的。宿主 `saveMetadataDebounced` 只核对角色／群组，排队的保存闭包又会在执行时读取当前上下文；同一角色快速切换聊天时尤其需要避免扩展在加载中安排保存。

Amin 在应用初始化前监听 `CHAT_CHANGED`，只有完成事件对应的聊天 ID、角色／群组、metadata 引用与 integrity 一致才允许共享写入及后台历史／地图／变量同步。聊天首次观察不再因补充历史记录而触发完整保存；原生变量的派生显示同步不触发延迟保存。记录真正变化时仍正常保存，用户确认的资料操作不会被静默丢弃。

这是对已发现的 Amin 触发路径的修复，不会修改 TauriTavern 的保存队列，也不能证明其他扩展没有相同问题。出现完整性弹窗时不要输入 OVERWRITE；保留宿主的拒绝覆盖与重新加载保护。
