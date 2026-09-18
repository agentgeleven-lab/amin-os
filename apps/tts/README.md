# 本地语音朗读

模型固定为 Azuma Bert-VITS2 2.3，东雪莲，G_18200.pth。插件本身不包含模型和 Python 环境。

1. 启动你的本地模型服务（现有“启动试听.cmd”）。
2. 在 Amin os 编辑布局中添加“语音朗读”磁贴，或打开楼层的“语音朗读”按钮。
3. 检查连接，检查/编辑待朗读文字，然后播放。不会自动朗读新消息，也不会修改正文。

接口：GET /health 返回 app=azuma-bert-vits2、ready=true、version=2.3、weights=G_18200.pth；POST /api/generate 接收 text、speed、seed，返回 audio/wav。仅连接本机 localhost/127.0.0.1。手机连接的是手机自身，不会自动访问电脑模型。

默认 speed=1、seed=42、音量=1；语速范围 0.7–1.3。服务端保持 sdp_ratio=0.2、noise_scale=0.6、noise_scale_w=0.8、length_scale=1/speed。只适配中文。长文本按标点分段，每段最多 220 字符，串行合成与播放。

服务必须允许酒馆来源跨域访问。现有 FastAPI 服务可添加 CORSMiddleware，明确允许 http://tauri.localhost、https://tauri.localhost、tauri://localhost 和本机 localhost/127.0.0.1 的酒馆端口，允许 GET、POST、Content-Type；继续仅监听 127.0.0.1，不需要开放公网。

停止会终止客户端等待并丢弃旧音频；已经在 GPU 内执行的单段推理可能仍会完成。收起窗口不打断朗读；切换聊天、编辑/删除/切换消息停止当前播放。浏览器阻止自动播放时点击“继续”。楼层仅读取酒馆显示正则处理后的可见正文，排除隐藏节点和交互控件，不回退到原始消息。播放前检查渲染结果是否更新，仍可手动编辑待朗读文字。
