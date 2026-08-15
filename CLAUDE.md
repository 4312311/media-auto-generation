# Media Auto Generation — 开发说明

SillyTavern (ST) 第三方前端插件。基于 wickedcode01 的 image-auto-generation 改写,扩展为支持视频生成。通过 ST 自带的 SD/ComfyUI 接口,在 AI 回复包含 `<pic prompt="...">` 或 `<video prompt="...">` 标签时自动生成图片/视频并替换到消息中。

## 功能概览

入口:右下角浮动按钮 `#media_auto_gen_float_btn` → 展开可拖动浮窗 `#media_auto_gen_panel_body`,内含 4 个 tab(对应 `settings.html` 的 `.mag-tab-btn` / `.mag-tab-panel`):

| Tab | data-mag-tab | 干什么 |
|---|---|---|
| 主要配置 | `main` | 总开关与正则:媒体类型(disabled/image/video)、图片/视频正则、`<img>` 标签的 style 属性 |
| ComfyUI 配置 | `comfy` | tab 顶部是**全局 ComfyUI 地址**(`activeComfyUrl` + 地址簿下拉 `comfyUrls`,跨配置档共享,hr 分隔线隔开);下方是多配置档系统:model/sampler/scheduler/width/height/steps/scale/denoise/seed + 正负面前缀 + 自定义工作流 JSON(API 格式)+ 预览图。配置档存 `extension_settings[extensionName].comfyPresets`,当前激活档 `activePresetName`。ComfyUI 走通后可替代默认的 ST SD 命令路径 |
| 角色固定特征 | `chars` | 角色名 → 固定 tag 字典(如 `Lisa → 1girl, chestnut hair`),生成时自动把 prompt 里的角色名替换为 `角色名, 特征tag`。存在 `characterTags` 设置项 |
| 图库 | `gallery` | 本插件生成过的所有图片/视频,按角色卡(`context.name2 \|\| groupId \|\| 'media'`)分组,`<details>` 折叠 + 缩略图网格,点击放大(modal lightbox)。数据在 `galleryManifest` |

核心触发机制:消息 DOM 中出现 `<pic prompt="...">` / `<video prompt="...">` 标签(正则可配),`processMessageContent` 匹配后调 SD/ComfyUI 生成,把标签替换为 `<img>`/`<video>`。同 prompt 有 3 分钟冷却(`PROMPT_COOLDOWN_MS`)。流式模式下 `GENERATION_STARTED` 启动 500ms 轮询只触发生成,`GENERATION_ENDED`/`STOPPED` 后统一落地。

**in-flight 媒体落地**(`landInFlightMedia()`,自动模式):生成完成的媒体先进 `inFlightMedia`(Map<promptHash, {mediaTag, declare, floor, originalTag, regexStr}>),非流式时每张完成立即落地,流式时等 `GENERATION_ENDED` 后的 `requestDebouncedUpdate` 落地。落地按 `floor`+`originalTag` 精确定位**触发时的楼层**——生成耗时 40s+,完成时该楼常已被用户新消息挤到非最后一楼,若只扫最后一楼会媒体丢失+标签永久卡死(裸标签留下,撞 3 分钟冷却不重生成,只能刷新);originalTag 失配(楼层被 swipe/删除/regex 脚本改写)时按 hash 重扫兜底,再失配则丢弃防泄漏。`GENERATION_STARTED` **不**清 inFlightMedia(清了会丢上一轮慢生成的媒体),切聊天才清(CHAT_CHANGED)。

**媒体预览浮窗**(流式看图用):发送栏图标 `#mag_preview_btn`(`#rightSendForm` 内,fa-images)打开居中 modal `#mag_media_preview_modal`,按楼层(新→旧)列出当前聊天全部生成媒体(含流式未落地 in-flight),层内按创建时间正序,一行一个可滚动;层间分隔线 + 『最新 / 第 N 楼的图片』标签;媒体上方显示紧邻其前的 `<pic_Declare>` 描述(**用户角色卡的 AI 输出惯例**:declare 块包着图片描述、紧贴 pic/video 标签,中间只隔空白/换行;隔着其他内容则不关联),下方显示创建时间(优先 `galleryManifest.timestamp`=生成完成时刻,回退 magId 内嵌 base36 时间戳)。数据源独立于消息 DOM:`collectFloorMedia()` 扫各楼层 `message.mes` 的 mag-media wrapper(`MAG_MEDIA_WRAP_RE`,与 `reduceMagMediaForLLM` 共用)+ 旧格式裸 `<img|video prompt=...>`(先剥 wrapper 再扫,避免空扫 MB 级 base64)+ 流式 `inFlightMedia`。自动刷新:`scheduleMediaPreviewRender()` 挂在 pushGalleryEntry / commitMediaToMessage / processMessageContent 落地 / GENERATION_STARTED / MESSAGE_EDITED / CHAT_CHANGED。

**旧楼层占位符补扫**:`processMessageContent` 只处理最后一楼(`chat.length - 1`),切进聊天(CHAT_CHANGED)时由 `processAllMessagesForPlaceholders()` 全量扫旧楼层裸 `<pic>/<video>` 标签转成占位符——**仅手动模式**生效(自动模式不动旧楼层,避免每次进聊天连环触发生成),prompt 提取/特征注入/hash 与逻辑 B-0 一致。

## 文件结构

- `index.js` — 主逻辑(约 3000 行,ES Module,无构建步骤,ST 直接加载)
- `settings.html` — 设置面板 UI(由 `index.js` 的 `createFloatingUI` 注入到可拖动浮窗 `#media_auto_gen_panel_body`)
- `manifest.json` — ST 插件清单
- `zh-cn.json` — 中文翻译
- `comfyui-flow.json` / `comfyUI-video` — ComfyUI 视频工作流示例(运行时不需要)
- `README.md` — 用户文档
- `CLAUDE.md` — 本文件

## 调试工作流(重要)

**绝对不要在 ST UI 里点 "Update" 按钮!** 那会执行 `git pull`,覆盖本地未提交的修改。本目录就是开发目录,改完文件直接浏览器刷新(Cmd+R)即可生效,ST 启动时读取磁盘文件。

### 标准调试协议(按此步骤执行)

本目录 local config (`~/.claude.json`) 已配置 **playwright** MCP,以下步骤假设它可用。若不可用(检查 `claude mcp list`),改用"手动回退"小节。

**步骤 1 — 确认 ST 在运行**
```bash
lsof -i :8000 -sTCP:LISTEN  # 没输出就启动 ST
```
ST 默认端口 8000,启动脚本:`/Users/zy/game/SillyTavern-Launcher/SillyTavern/start.sh`(建议 `tee` 到 `logs/st-debug.log` 方便 Claude 读取后端报错)

**步骤 2 — 打开 ST 并登录**
用 playwright 打开 `http://localhost:8000`,选择有该插件配置的用户登录。打开后停留在能触发媒体生成的聊天页(需要有角色卡 + 插件已启用 image/video 模式)。

**步骤 3 — 改代码**
直接 Edit `index.js` / `settings.html` 等。ST 用 ES Module 加载,文件保存即磁盘生效,**不需要任何 reload/重新安装**。

**步骤 4 — 让浏览器重新加载插件代码**
- 优先:playwright 调浏览器刷新(`Cmd+R` 等效动作)
- ST 的前端是 SPA,刷新整页是最可靠的"重新加载插件代码"方式
- 仅改 `settings.html` 也需要刷新,因为它是启动时 fetch 的

**步骤 5 — 复现 + 捕获 console**
触发一次媒体生成(发一条带 `<pic prompt="...">` 或 `<video prompt="...">` 的消息,或让 AI 回复带标签)。用 playwright 读取 console:
- `[media-auto-generation]` 开头的 log = 插件主动打的(角色注入、生成成功/失败)
- 报错堆栈里的 `extensions/third-party/media-auto-generation` = 插件代码崩了
- 其他报错(SD/ComfyUI/网络)= 后端或外部服务问题

**步骤 6 — 循环**
- 有报错 → 回到步骤 3 修代码 → 步骤 4 刷新 → 步骤 5 再测
- 没报错但行为不对 → 用 playwright 截图 + 读 DOM,对比预期

### 后端日志(图片/视频调用 SD 失败时查)

```bash
ls /Users/zy/game/SillyTavern-Launcher/SillyTavern/logs/
```
若 ST 没有日志输出,提示用户用 `./start.sh 2>&1 | tee logs/st-debug.log` 重启 ST。SD/ComfyUI 自己的日志在它们各自的运行终端。

### Playwright MCP 调用要点

- 第一次调用会启动一个独立的 Chromium 窗口(非用户当前浏览器),需要在 ST 重新登录/选用户一次
- 优先用 `navigate` 打开 ST 而不是 `browser_launch`,前者更轻
- 调试完用 `close` 关掉,避免进程残留
- 如果用户已经在自己浏览器里调试更顺手,可以让用户手动操作,你只用 playwright 读 console(打开页面后挂着监听)
- **`browser_evaluate` 等任何会让出事件循环的调用(`browser_snapshot` / `browser_click` / `browser_take_screenshot` 等)都可能触发 ST 浮窗的"点外部自动收起"逻辑**,导致下次截图/快照看到的是 `display:none` 的隐藏态。调试浮窗时要么把要读的状态**一次 evaluate 全部读出**,要么 evaluate 后显式 `toggleFloatingPanel(true)` 重新展开再继续。本插件曾因此看到 `#media_auto_gen_panel` 的 rect 变 0,0,0,0,误以为代码出问题。

### 手动回退(没有 Playwright 时)

让用户:
1. 在 ST 浏览器里 Cmd+R 刷新
2. 复制 DevTools Console 的报错粘给你
3. 必要时截图给你(zai-mcp-server 可分析图像)

## 代码地图(index.js)

### 关键状态(模块级变量)
- `inFlightMedia: Map<promptHash, {mediaTag, declare, floor, originalTag, regexStr}>` — 生成完成待落地的媒体中转(消费即删,见功能概览"in-flight 媒体落地")
- `promptHistory: Map<hash, timestamp>` — 生成历史,用于 3 分钟冷却(`PROMPT_COOLDOWN_MS`)
- `processingHashes: Set<hash>` — 正在生成中的锁,防并发重入
- `failedPrompts: Map<hash, errorMessage>` — 生成失败记录,流式结束后渲染 error 占位符供手动重试
- `isStreamActive` / `streamInterval` — 流式生成期间的状态

### 核心函数
- `processMessageContent(isFinal, onlyTrigger)` — **主入口**。匹配最后一条消息中的标签:手动模式渲染占位符 / 自动模式触发生成 / 失败降级 error 占位符(媒体落地不在此,见下行)
- `landInFlightMedia()` — 自动模式媒体落地:按 inFlightMedia 记录的触发楼层+标签原文把成品写回 mes(见功能概览"in-flight 媒体落地")
- `processAllMessagesForPlaceholders()` — CHAT_CHANGED 旧楼层裸标签补扫(仅手动模式,见功能概览)
- `collectFloorMedia()` / `declareForPosition()` / `renderMediaPreviewModal()` / `scheduleMediaPreviewRender()` — 媒体预览浮窗(见功能概览)
- `commitMediaToMessage(magId, mediaWrap, caller)` — 手动/重生成按 magId 反查任意楼层落地
- `MAG_MEDIA_WRAP_RE` — mag-media wrapper 共享正则(LLM 清理 + 楼层扫描两用)
- `injectCharacterTags(rawPrompt, tagsDict)` — 角色固定特征注入。把角色名替换为 `角色名, 特征tag`
- `requestDebouncedUpdate(isFinal)` — 200ms 防抖更新消息 DOM
- `loadSettings` / `bindSettingsEvents` / `updateUI` — 设置加载与事件绑定
- `createFloatingUI` / `initPanelDrag` / `initFloatBtnDrag` / `toggleFloatingPanel` — 浮动按钮 + 可拖动浮窗(自写 mousedown,不依赖 ST `dragElement`,见"ST 前端踩坑笔记")
- `renderCharacterTagsList` — 角色特征列表 UI 渲染

### 事件监听(底部)
- `GENERATION_STARTED` — 流式开始,启动 500ms 轮询触发生成(只触发不替换)
- `GENERATION_ENDED` / `GENERATION_STOPPED` — 流式结束,做最终替换
- `MESSAGE_RECEIVED` — 非流式场景,直接处理
- `MESSAGE_EDITED` — 消息编辑保存后重跑处理 + 刷新预览浮窗
- `CHAT_CHANGED` — 清 in-flight、关预览浮窗、`processAllMessagesForPlaceholders()` 旧楼层补扫

### 默认正则(在 `defaultSettings`)
- 图片: `/<pic\b(?![^>]*\bsrc\s*=)(?:(?:(?!\bprompt\b)[^>])*\blight_intensity\s*=\s*"([^"]*)")?(?:(?!\bprompt\b)[^>])*\bprompt\s*=\s*"([^"]*)"[^>]*>/gi`
- 视频: `/<video\b(?:(?:(?!\bprompt\b)[^>])*\bvideoParams\s*=\s*"([^"]*)")?(?:(?!\bprompt\b)[^>])*\bprompt\s*=\s*"([^"]*)"[^>]*>/gi`

捕获组 1 = 额外参数(图片:`light_intensity,sunshine`;视频:`frameCount,width,height`),捕获组 2 = prompt

## 依赖的 ST API

通过相对路径 import:
- `../../../extensions.js` → `extension_settings`, `getContext`
- `../../../../script.js` → `saveSettingsDebounced`, `eventSource`, `event_types`, `updateMessageBlock`
- `../../../utils.js` → `regexFromString`, `clamp`
- `../../../slash-commands/SlashCommandParser.js` → 调用 SD 命令:`SlashCommandParser.commands['sd'].callback({quiet:'true'}, finalPrompt)`

调用 SD 接口时,prompt 中可用 ST 的宏(如 `{{setvar::xxx::yyy}}`),会被 ST 解析后传给 ComfyUI。

## ST 前端踩坑笔记

写浮层 / 拖动 UI 时一定会踩的坑,提前规避:

- **`dragElement($el)`(`scripts/RossAscends-mods.js:477`)不能用于内嵌浮窗的标题栏**。它强依赖 `.drag-grabber` 类,而 ST 全局 CSS 在 `style.css:790` 强制 `.drag-grabber { position: absolute; }`,会把标题栏从文档流中拔出、叠到下方控件上(本插件曾导致关闭按钮盖住下方 checkbox)。仅适用于 ST 自带 movingUI 浥浮工具栏。需要可拖动浮窗时自写 `mousedown`/`touchstart`(参考本插件 `initPanelDrag` / `initFloatBtnDrag`)。还有:它把位置写进 `power_user.movingUIState`、`power_user.movingUI === false` 时直接 abort、`isMobile()` 时禁用 — 三层耦合都不适合第三方常驻浮层。

- **jQuery `.toggle()` 对 `display:flex` 元素会强制变成 `display:block`**。用 `.css('display', 'flex' / 'none')` 显式控制,不要用 `.toggle()` / `.show()`。

- **`saveSettingsDebounced` 实际防抖 1000ms**(`debounce_timeout.relaxed`,见 `scripts/constants.js:14`)。验证位置/设置持久化时,改完至少等 1s 再刷新,否则保存还没落盘。需要立即 flush(如显式"保存"按钮)用 `saveSettings()`(`script.js:7819`),无防抖。

- **`data-i18n` 默认替换整个 textContent,会把子元素吃掉**。`i18n.js:152-167` 的 `translateElement` 对没带属性前缀的 key 执行 `element.textContent = localizedValue`,这会**清空**元素里所有子节点(包括 `<i class="fa-...">` 图标),只留翻译后的文字。本插件曾导致 `+` 新建按钮显示成"最新"文字、`<i>` 图标消失。**正确做法**:只想翻译属性(tooltip 等)保留 innerHTML,用 `data-i18n="[title]key"` 语法(`[attr]key` 前缀只改属性);内层包一个 `<span data-i18n="key">text</span>` 也可以让 textContent 替换局限在 span 内,不影响同级的 `<i>`。

- **ST 全局 i18n 字典优先级 > 插件 zh-cn.json**。简单 key 名(单字/常见词如 `"New"`、`"Save"`、`"Delete"`)会被全局字典覆盖,插件的翻译不生效(本插件 `"New": "新建"` 没生效,因为全局翻成 `"最新"`)。**防御措施**:插件 i18n key 加独特后缀(如 `"New Preset"` 而非 `"New"`、`"comfy_save"` 而非 `"Save"`)。

- **`extension_settings` 是模块作用域变量,不在 `window` 上**。Playwright `browser_evaluate` 读不到 `window.extension_settings`。验证持久化只能"改 → 等 1s → 刷新 → 读 DOM"。

## Git

- 远程:`git@github.com:4312311/media-auto-generation.git` (SSH)
- 开发建议在 `dev` 分支,避免 main 上堆积未提交改动导致以后真正想 pull 时冲突

## 测试要点

改完后至少验证:
1. 图片模式(`<pic prompt="...">`)→ 是否替换、是否走缓存
2. 视频模式(`<video prompt="...">`)→ 是否替换、参数解析
3. 流式模式 → 流式期间提前触发生成(500ms 轮询只触发不改 DOM,固定行为无开关),流式结束统一替换
4. 角色特征注入 → 命中角色名后是否附加 tag
5. 冷却逻辑 → 同一 prompt 3 分钟内不重复生成
