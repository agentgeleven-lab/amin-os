# Windows 本地语音启动器

安装一次后，Amin os → 语音 → 语音与识别设置 → 选择本地引擎 → 启动本地服务。
首次 Windows / 浏览器可能要求允许打开 Amin TTS Launcher。按钮仅启动服务，不合成、不调用付费 API。
服务已经运行时不重复启动。连接后可播放；DXL1 服务重启后需在“打开本地配置页”重新填写 MiMo 密钥。

安装（PowerShell，把目录替换为你本机的实际模型目录）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -AzumaDirectory "C:\models\azuma-bert-vits2" -MimoDirectory "C:\models\mimo-rvc-studio"
```

启动器安装于 `%LOCALAPPDATA%\AminOS\TTSLauncher`，仅注册当前用户的 `amin-tts` URL 协议；无需管理员权限、后台常驻或开机启动。仅允许两个固定 URI，不允许网页指定路径、命令或凭据。原有 Python / CUDA / 模型依赖仍需保留。

失败记录：启动器目录 `last-error.txt`、各模型目录 `server-error.log`。未安装或宿主阻止外部协议时，仍可使用原来的 `启动试听.cmd`。退出酒馆不会自动关闭服务。

卸载注册：运行启动器目录 `uninstall.ps1`。不删除模型、配置文件或终止已运行服务。
