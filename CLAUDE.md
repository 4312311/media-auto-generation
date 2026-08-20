# Media Auto Generation — 开发说明

SillyTavern (ST) 第三方前端插件。基于 wickedcode01 的 image-auto-generation 改写,扩展为支持视频生成。通过 ST 自带的 SD/ComfyUI 接口,在 AI 回复包含 `[image]...[/image]` 或 `[video]...[/video]` 标签时自动生成图片/视频并替换到消息中。

## 铁律(最高优先级,覆盖一切默认行为)

**绝对禁止通过修改 SillyTavern 源码(`F:\silly\src\` 等酒馆本体文件)的方式来实现插件功能。** 插件的任何能力只能依靠:插件自身代码 / ST 原生已有的 API / 浏览器能力(如带 `--enable-cors-header` 的 ComfyUI 直连)。插件装在别人机器上时不会有这些补丁,靠改宿主源码实现的功能等于只在开发机上成立。ST 后端缺端点时,先找浏览器直连等替代路径(参考 `fetchComfyComboOptions` 及其封装 `fetchLorasDirect` / `fetchUpscaleModelsDirect`)。LoRA/放大模型列表均已迁移为浏览器直连,插件不再调用任何后端补丁端点;macOS 机 `/api/sd/comfy/loras` 后端补丁已成死代码,可自行移除。

## 功能概览

入口:右下角浮动按钮 `#media_auto_gen_float_btn` → 展开可拖动浮窗 `#media_auto_gen_panel_body`,内含 4 个 tab(对应 `settings.html` 的 `.mag-tab-btn` / `.mag-tab-panel`):

| Tab | data-mag-tab | 干什么 |
|---|---|---|
| 主要配置 | `main` | 总开关与正则:媒体类型(disabled/image/video)、图片/视频正则、`<img>` 标签的 style 属性 |
| ComfyUI 配置 | `comfy` | tab 顶部是**全局 ComfyUI 地址**(`activeComfyUrl` + 地址簿下拉 `comfyUrls`,跨配置档共享,hr 分隔线隔开);下方是多配置档系统:model/sampler/scheduler/width/height/steps/scale/denoise/seed + 正负面前缀 + 自定义工作流 JSON(API 格式)+ 预览图。配置档存 `extension_settings[extensionName].comfyPresets`,当前激活档 `activePresetName`。Sampler/Scheduler 行下方**放大模型下拉**(`preset.upscaleModel`,首项『不使用』=空值不注入;选中后**生成时**由 `injectUpscaleIntoWorkflowJson` 动态图手术注入 `UpscaleModelLoader` + `ImageUpscaleWithModel`——插在终端图像输出节点(输出未被任何节点消费、且 `images` 输入为节点引用的节点,PreviewImage/SaveImage/VideoCombine 通吃)之前,同源终端共享一个放大节点,异源各插一个;工作流已带接线好的放大链时只覆盖 loader 的 `model_name`;**不改动 preset.workflowJson**,JSON 无效/找不到终端时打 warn 原样放行)。列表由 `refreshComfyOptions` 调 `fetchUpscaleModelsDirect` **浏览器直连** ComfyUI `/object_info/UpscaleModelLoader`(兼容新版 `["COMBO",{options}]` 与旧版 `[0]` 数组两种返回)——**要求 ComfyUI 启动带 `--enable-cors-header`**(Windows 机的 `F:\romote confyUI\start_comfyui_directly.bat` 已加;不带该参数时浏览器直连被新版 ComfyUI 的 Origin 校验 403,拉不到列表只降级为下拉回显已存值,生成注入不受影响)。工作流 JSON 下方 LoRA 编辑列表:行内改 `strength_model` 自动写回;行尾 × 删除节点;『新增 LoRA』下拉按 `comfyCache.loras` 过滤选择(列表由 `refreshComfyOptions` 调 `fetchLorasDirect` **浏览器直连** ComfyUI `/object_info/LoraLoader`(节点缺失时退 `LoraLoaderModelOnly`),同样要求 `--enable-cors-header`;失败降级为手动输入文件名回车)。点『连接』拉到的五类列表(models/samplers/schedulers/loras/upscaleModels)按 ComfyUI 地址分档持久化到 `comfyListCache`(key 去尾斜杠;只覆盖本轮成功拉到的组,部分失败保留旧档);`renderPresetFields` 开头有失配守卫——内存 `comfyCache.url` ≠ 当前地址时 `hydrateComfyCacheFromSettings()` 自动灌回存档,刷新页面/切配置档/地址簿切走再切回都不需要重新连接,点『连接』才刷新为最新。增删是图手术(`addLoraToWorkflow` 链尾插入 / `removeLoraFromWorkflow` 旁路重接),写回会整体重排 JSON 排版。ComfyUI 走通后可替代默认的 ST SD 命令路径 |
| 角色固定特征 | `chars` | 角色名 → 固定 tag 字典(如 `Lisa → 1girl, chestnut hair`),生成时自动把 prompt 里的角色名替换为 `角色名, 特征tag`。存在 `characterTags` 设置项 |
| 图库 | `gallery` | 本插件生成过的所有图片/视频,按角色卡(`context.name2 \|\| groupId \|\| 'media'`)分组,`<details>` 折叠 + 缩略图网格,点击放大(modal lightbox)。数据在 `galleryManifest` |

核心触发机制:消息中出现 `[image]提示词[/image]` / `[video]提示词[/video]` 标签(BBCode 式,prompt 在标签体内,正则可配),`processMessageContent` 匹配后调 SD/ComfyUI 生成,把标签替换为 mag-media wrapper(内嵌 `<img>`/`<video>`)。同 prompt 有 3 分钟冷却(`PROMPT_COOLDOWN_MS`)。流式模式下 `GENERATION_STARTED` 启动 500ms 轮询只触发生成,`GENERATION_ENDED`/`STOPPED` 后统一落地。prompt 提取统一走 `extractTagPrompt(match)`(组1=成对分支、组2=漏闭合兜底分支,换行折叠为空格)。**流式期间(isFinal=false)只认成对分支(组1),兜底分支被守卫跳过**——否则半截流式输出每轮匹配到不同长度的行内前缀,hash 每轮不同导致冷却/并发锁全失效、疯狂重复触发生成,且落地时半截 originalTag 是完整标签前缀,前缀替换会留下 `[/image]` 残尾(2026-08 实测事故)。旧 `<pic prompt="...">` 属性式格式已废弃不做兼容——属性内引号/换行是结构性字符,AI 输出易坏;loadSettings 里检测存值含 `<pic`/`<video` 自动迁移到新默认正则(注意:历史默认正则的源码字符串用单反斜杠,经 JS 字面量解析 `\s`→`s`、`\b`→退格,从未生效过,用户实际用的是 UI 手配正则)。

**in-flight 媒体落地**(`landInFlightMedia()`,自动模式):生成完成的媒体先进 `inFlightMedia`(Map<promptHash, {mediaTag, declare, floor, originalTag, regexStr}>),非流式时每张完成立即落地,流式时等 `GENERATION_ENDED` 后的 `requestDebouncedUpdate` 落地(生成完成回调另有 10s 延迟重试兜底流式结束事件丢失)。落地按 `floor`+`originalTag` 精确定位**触发时的楼层**——生成耗时 40s+,完成时该楼常已被用户新消息挤到非最后一楼,若只扫最后一楼会媒体丢失+标签永久卡死(裸标签留下,撞 3 分钟冷却不重生成,只能刷新);originalTag 失配(楼层被 swipe/删除/regex 脚本改写)时按 hash 重扫兜底,再失配则丢弃防泄漏。**流式期间只滞留"流式目标楼(最后一楼)"**(它的 mes 被 ST 流式持续重写,中途写会被冲掉),非流式楼照常落地——不能顶层 `isStreamActive` 一票否决,否则流式结束事件丢失/时序异常时媒体永久滞留(2026-08 实测:生成成功入图库但零落地)。`GENERATION_STARTED` **不**清 inFlightMedia(清了会丢上一轮慢生成的媒体),切聊天才清(CHAT_CHANGED)。

**媒体预览浮窗**(流式看图用):发送栏图标 `#mag_preview_btn`(`#rightSendForm` 内,fa-images)打开居中 modal `#mag_media_preview_modal`,按楼层(新→旧)列出当前聊天全部生成媒体(含流式未落地 in-flight),层内按创建时间正序,一行一个可滚动;层间分隔线 + 『最新 / 第 N 楼的图片』标签;媒体上方显示紧邻其前的 declare 描述(`PIC_DECLARE_RE` 兼容 `[img_Declare]...[/img_Declare]`(2026-08 起用户卡的 BBCode 新格式)与 `<pic_Declare>...</pic_Declare>`(旧卡)两种;**用户角色卡的 AI 输出惯例**:declare 块包着图片描述、紧贴 [image]/[video] 标签,中间只隔空白/换行;隔着其他内容则不关联;declare 是用户卡的约定,插件只读不约束格式),下方显示创建时间(优先 `galleryManifest.timestamp`=生成完成时刻,回退 magId 内嵌 base36 时间戳)。数据源独立于消息 DOM:`collectFloorMedia()` 扫各楼层 `message.mes` 的 mag-media wrapper(`MAG_MEDIA_WRAP_RE`)+ 旧格式裸 `<img|video prompt=...>`(先剥 wrapper 再扫,避免空扫 MB 级 base64)+ 流式 `inFlightMedia`。自动刷新:`scheduleMediaPreviewRender()` 挂在 pushGalleryEntry / commitMediaToMessage / processMessageContent 落地 / GENERATION_STARTED / MESSAGE_EDITED / CHAT_CHANGED。

**旧楼层占位符补扫**:`processMessageContent` 只处理最后一楼(`chat.length - 1`),切进聊天(CHAT_CHANGED)时由 `processAllMessagesForPlaceholders()` 全量扫旧楼层裸 `[image]/[video]` 标签转成占位符——**仅手动模式**生效(自动模式不动旧楼层,避免每次进聊天连环触发生成),prompt 提取/特征注入/hash 与逻辑 B-0 一致。

**LLM 伪造 mag-* HTML 防御**(入口单端;出口还原已移交 ST Regex 扩展):LLM 一旦见过 wrapper HTML(跨设备拷贝的旧聊天等存量污染),会模仿输出"假壳 wrapper + 模仿尾巴"——在 `[image]` 外套伪造的 mag-media span、`</span>` 后重复输出 `<small data-mag-role=...>` 尾巴且常少写 `</small>`;未闭合 small 吞掉后续正文,叠加嵌套后文字逐层变小变暗(12.75px→10.6→8.85px + role 元素 opacity:0.7)、图片套 0.7 蒙层,即"图片后文字越来越小变暗"渲染事故。防御:
- **入口** `sanitizeFreshLlmMessage()`:MESSAGE_RECEIVED / GENERATION_ENDED(STOPPED) 时(插件尚未写入任何 wrapper,此刻 mes 里的 mag-* HTML 必为 LLM 伪造,判据无歧义)调 `sanitizeLlmMagHtml()` 中和——剥 mag span 开标签 + 游离 data-mag-role 元素(紧闭合的连内容删、未闭合的只删开标签保正文),`[image]` 原样保留走正常管线。continue 场景用 `GENERATION_STARTED` 时快照的最后楼 mes(`preGenerationMesSnapshot`)把处理范围限制在追加段,不误伤同楼已落地的真 wrapper;编辑/切聊天重扫路径**不**调用(存量楼层不动)。
- **出口(已移除,由 ST Regex 扩展承担)**:发 LLM 前把 wrapper/占位符还原成 `[image]prompt[/image]` 的正则脚本配置在 README"发给 LLM 前的还原"章节——两条规则(wrapper/占位符通吃,lookahead 双锚点取 `data-media-type`/`data-prompt`,勾 AI Output + Only Format Prompt)。**插件不再挂 GENERATE_AFTER_COMBINE_PROMPTS / CHAT_COMPLETION_PROMPT_READY 监听**;若 ST Regex 未配置,wrapper(含 MB 级 base64)会原样进 LLM 上下文。历史:插件曾内置 `reduceMagMediaForLLM` 出口折叠,2026-08 应用户要求删除改走 ST 原生正则。

## 文件结构

- `index.js` — 主逻辑(约 3000 行,ES Module,无构建步骤,ST 直接加载)
- `settings.html` — 设置面板 UI(由 `index.js` 的 `createFloatingUI` 注入到可拖动浮窗 `#media_auto_gen_panel_body`)
- `manifest.json` — ST 插件清单
- `zh-cn.json` — 中文翻译
- `comfyui-flow.json` / `comfyUI-video` — ComfyUI 视频工作流示例(运行时不需要)
- `README.md` — 用户文档
- `CLAUDE.md` — 本文件

## 调试工作流(重要)

**绝对不要在 ST UI 里点 "Update" 按钮!** 那会执行 `git pull`,覆盖本地未提交的修改。本目录就是开发目录,改完文件直接浏览器刷新(Cmd/Ctrl+R)即可生效,ST 启动时读取磁盘文件。

### 标准调试协议(按此步骤执行)

本目录 local config (`~/.claude.json`) 已配置 **playwright** MCP,以下步骤假设它可用。若不可用(检查 `claude mcp list`),改用"手动回退"小节。注意 local config **不随 git 仓库走**,换新机器要重装(macOS / Windows 通用):
```bash
claude mcp add playwright -- npx @playwright/mcp@latest
```

**步骤 1 — 确认 ST 在运行**

两台开发机(macOS / Windows,Windows 上 Claude Code 跑 Git Bash)检查命令不同:

```bash
# macOS
lsof -i :8000 -sTCP:LISTEN
# Windows(Git Bash;已实测能命中 netstat 输出格式)
netstat -ano | grep -E ':8000\s.*LISTENING'   # 没输出就启动 ST
```

ST 默认端口 8000。启动方式按平台(都建议 `tee` 到日志文件,Claude 才能直接读后端报错):
- **macOS**:ST 根 `/Users/zy/game/SillyTavern-Launcher/SillyTavern/`,用 `./start.sh 2>&1 | tee logs/st-debug.log`
- **Windows**:ST 根就是本插件目录往上四级的 `F:\silly`。Git Bash 里用 `cd /f/silly && node server.js 2>&1 | tee st-debug.log`(根目录的 `start.sh` 也能跑但每次先 npm install 较慢;`Start.bat` 是给双击用的,日志不方便读取)

**步骤 2 — 打开 ST 并登录**
用 playwright 打开 `http://localhost:8000`,选择有该插件配置的用户登录。打开后停留在能触发媒体生成的聊天页(需要有角色卡 + 插件已启用 image/video 模式)。

**步骤 3 — 改代码**
直接 Edit `index.js` / `settings.html` 等。ST 用 ES Module 加载,文件保存即磁盘生效,**不需要任何 reload/重新安装**。

**步骤 4 — 让浏览器重新加载插件代码**
- 优先:playwright 调浏览器刷新(`Cmd/Ctrl+R` 等效动作)
- ST 的前端是 SPA,刷新整页是最可靠的"重新加载插件代码"方式
- 仅改 `settings.html` 也需要刷新,因为它是启动时 fetch 的

**步骤 5 — 复现 + 捕获 console**
触发一次媒体生成(发一条带 `[image]...[/image]` 或 `[video]...[/video]` 的消息,或让 AI 回复带标签)。用 playwright 读取 console:
- `[media-auto-generation]` 开头的 log = 插件主动打的(角色注入、生成成功/失败)
- 报错堆栈里的 `extensions/third-party/media-auto-generation` = 插件代码崩了
- 其他报错(SD/ComfyUI/网络)= 后端或外部服务问题

**步骤 6 — 循环**
- 有报错 → 回到步骤 3 修代码 → 步骤 4 刷新 → 步骤 5 再测
- 没报错但行为不对 → 用 playwright 截图 + 读 DOM,对比预期

### 后端日志(图片/视频调用 SD 失败时查)

- **macOS**:`ls /Users/zy/game/SillyTavern-Launcher/SillyTavern/logs/`
- **Windows**:`F:\silly` 下没有 `logs/` 目录,后端输出只在启动它的终端里——要 Claude 能查就用步骤 1 的 `node server.js 2>&1 | tee st-debug.log` 启动,日志落在 ST 根 `st-debug.log`

若 ST 已在跑但没接 tee,提示用户按上述方式重启 ST。SD/ComfyUI 自己的日志在它们各自的运行终端。

### Playwright MCP 调用要点

- 第一次调用会启动一个独立的 Chromium 窗口(非用户当前浏览器),需要在 ST 重新登录/选用户一次
- 优先用 `navigate` 打开 ST 而不是 `browser_launch`,前者更轻
- 调试完用 `close` 关掉,避免进程残留
- 如果用户已经在自己浏览器里调试更顺手,可以让用户手动操作,你只用 playwright 读 console(打开页面后挂着监听)
- **`browser_evaluate` 等任何会让出事件循环的调用(`browser_snapshot` / `browser_click` / `browser_take_screenshot` 等)都可能触发 ST 浮窗的"点外部自动收起"逻辑**,导致下次截图/快照看到的是 `display:none` 的隐藏态。调试浮窗时要么把要读的状态**一次 evaluate 全部读出**,要么 evaluate 后显式 `toggleFloatingPanel(true)` 重新展开再继续。本插件曾因此看到 `#media_auto_gen_panel` 的 rect 变 0,0,0,0,误以为代码出问题。

### 手动回退(没有 Playwright 时)

让用户:
1. 在 ST 浏览器里 Cmd/Ctrl+R 刷新
2. 复制 DevTools Console 的报错粘给你
3. 必要时截图给你(zai-mcp-server 可分析图像)

### 流式/异步时序类 bug 调试守则(2026-08 "生成了没落地"事故复盘沉淀)

这类 bug(事件驱动 + 异步回调 + 状态标志)的调试守则,按优先级:

1. **第一时间拿用户窗口的 console**,别自己闷头推。playwright 是独立 Chromium,读不到用户正在用的浏览器;而本插件这类 bug 的决定性证据(落地失败 warn / 事件时序)只在用户窗口产生。开口要:"复测一次,把 console 里 `[media-auto-generation]` 开头的行和所有 warn/error 复制给我"。
2. **代码推演最多 2 轮**。两次都得出"应该通"而实测不通,说明推演的某个前提错了——继续推演不产出新信息,立即换路:要么要 console,要么给可疑分支加日志让用户复测时证据自动产生。
3. **修这类 bug 时,同步给静默 return/skip 分支加日志**。`landInFlightMedia` 的 isStreamActive 跳过、失配丢弃都是零日志黑洞——正是"图库有记录但零落地却无任何线索"的原因。修复 + 加可观测性一起交付,复测即产出证据。
4. **推测性修复要明说,并附复测脚本**。修复无法在本地复现验证时(能复现的场景早就修好了),交付时说明"这是基于排除法的推测",并给确认清单 + 还坏时的反馈模板(要什么信息),减少反馈往返失真。
5. **设计会被重复执行的匹配逻辑时,先做增量输入审查**:问"输入在两次执行之间变化时(流式半截输出),每次的匹配结果/hash 是否稳定?"。冷却/并发锁等幂等防御挡不住"输入本身在变"的场景(2026-08 兜底分支疯狂触发事故的根因)。
6. **在宿主(ST)上做写操作自动化前,先 grep 宿主源码确认控件机制**(编辑框 jQuery 管理、`.mes_edit_done`),读操作无害可以试探,写操作错姿势会污染用户数据。

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
- `MAG_MEDIA_WRAP_RE` — mag-media wrapper 正则(collectFloorMedia 楼层扫描用)
- `extractTagPrompt(match)` — 从触发正则 match 提取 prompt(三处扫描点共用:processMessageContent / landInFlightMedia hash 重扫 / processAllMessagesForPlaceholders),组1=成对分支、组2=漏闭合兜底,换行折叠为空格
- `sanitizeLlmMagHtml` / `sanitizeFreshLlmMessage` / `preGenerationMesSnapshot` — LLM 伪造 mag-* HTML 入口防御(见功能概览;出口还原已移交 ST Regex 扩展)
- `injectCharacterTags(rawPrompt, tagsDict)` — 角色固定特征注入。把角色名替换为 `角色名, 特征tag`
- `applyWorkflowPlaceholders` / `injectUpscaleIntoWorkflowJson` / `generateViaComfy` — ComfyUI 生成管线:占位符替换 → 放大模型注入(preset.upscaleModel 非空时)→ 串行队列发 `/api/sd/comfy/generate`(见功能概览 ComfyUI 配置 tab 行)
- `requestDebouncedUpdate(isFinal)` — 200ms 防抖更新消息 DOM
- `loadSettings` / `bindSettingsEvents` / `updateUI` — 设置加载与事件绑定
- `createFloatingUI` / `initPanelDrag` / `initFloatBtnDrag` / `toggleFloatingPanel` — 浮动按钮 + 可拖动浮窗(自写 mousedown,不依赖 ST `dragElement`,见"ST 前端踩坑笔记")。浮标另有:`floatBtnMetrics`(默认位尺寸/边距参数)/ `clampFloatBtnIntoView`(恢复落盘位置 & resize/orientationchange 时把浮标拉回屏内,只改视觉不落盘)/ `resetFloatBtnPosition`(手机端从 wand 菜单打开面板时把浮标重置回默认右下角并落盘——浮标被吸附/挤出屏后的救援通道)+ 模块级 `floatBtnDockedEdge` 吸附运行态(手机端吸附少藏:settings.html 的 `.mag-mobile` 覆盖为 translateX ±45%/opacity .8,桌面 ±65%/.5)
- `renderCharacterTagsList` — 角色特征列表 UI 渲染

### 事件监听(底部)
- `GENERATION_STARTED` — 流式开始,启动 500ms 轮询触发生成(只触发不替换)+ 快照最后楼 mes(入口防御用)。回调**必须检查第 3 个参数 dryRun 并忽略**——dryRun 调用只有 STARTED 没有 ENDED,不忽略会让 isStreamActive 永真(见"ST 前端踩坑笔记"最后一条)
- 流式轮询带自愈:盯 `body.dataset.generating`(ST 的 UI 锁定标志),"见过 true 后变删除"却没等到 ENDED 就自行按流式结束收尾(onGenerationFinished 幂等,与真 ENDED 重复执行无害)
- `GENERATION_ENDED` / `GENERATION_STOPPED` — 流式结束,先 `sanitizeFreshLlmMessage()` 中和伪造 mag-* HTML(带 try/catch 防异常挡住落地),再做最终替换
- `MESSAGE_RECEIVED` — 非流式场景,同样先中和再处理
- `MESSAGE_EDITED` — 消息编辑保存后重跑处理 + 刷新预览浮窗
- `CHAT_CHANGED` — 清 in-flight、关预览浮窗、`processAllMessagesForPlaceholders()` 旧楼层补扫

### 默认正则(在 `defaultSettings`)

- 图片: `/\[image\][ \t]*([\s\S]*?)[ \t]*\[\/image\]|\[image\][ \t]*([^\n\[]+)/gi`
- 视频: `/\[video\][ \t]*([\s\S]*?)[ \t]*\[\/video\]|\[video\][ \t]*([^\n\[]+)/gi`

双分支:分支 1 成对标签(组 1 = prompt,非贪婪到闭合标签,体内引号/换行/`[` 权重语法均安全);分支 2 漏闭合兜底(组 2 = 行内内容,到换行或 `[` 止)。**注意源码里必须写双反斜杠**(`'\\[image\\]...'`)——单反斜杠会被 JS 字符串字面量解析吃掉(`\s`→`s`、`\b`→退格符),旧版默认正则就坏在这里从未生效过。旧参数管线(light_intensity/videoParams → data-extra 透传)已整体删除,占位符/wrapper 不再有 data-extra 属性。

## 依赖的 ST API

通过相对路径 import:
- `../../../extensions.js` → `extension_settings`, `getContext`
- `../../../../script.js` → `saveSettingsDebounced`, `eventSource`, `event_types`, `updateMessageBlock`
- `../../../utils.js` → `regexFromString`, `clamp`
- `../../../slash-commands/SlashCommandParser.js` → 调用 SD 命令:`SlashCommandParser.commands['sd'].callback({quiet:'true'}, finalPrompt)`

调用 SD 接口时,prompt 中可用 ST 的宏(如 `{{setvar::xxx::yyy}}`),会被 ST 解析后传给 ComfyUI。

## 工程模型与设计原则(2026-08 标签格式迁移事故沉淀)

### 给 LLM 设计触发标签格式的原则

- **prompt 放标签体内,不放属性**:`<pic prompt="...">` 属性式里引号/换行/`&` 是结构性字符,AI 写场景描述天然带这些字符,一写就坏;`[image]prompt[/image]` 体内是自然语言,无转义需求。AI 对"标签包裹内容"结构的遵循率也远高于"属性含长文本"。
- **成对闭合天然抗流式半截**:闭合标签(`[/image]`)出现前正则不匹配 → 流式轮询期间半截输出不会误触发。漏闭合兜底分支则相反,必须配"消息完整后才生效"的守卫(见代码地图 processMessageContent)。
- **避开有强先验的标签名**:`[img]` 是几十年标准 BBCode 贴图标签,会诱导 AI 往体内填 URL 而不是 prompt 描述;中文名(`[图]`)会和中文正文里的方括号旁白混。
- **幂等防御挡不住"输入在变"**:冷却(promptHistory)/并发锁(processingHashes)/hash 去重的前提是"同输入重复出现";流式增量输出下每轮匹配到不同长度的半截文本 → hash 每轮不同 → 全部防御失效、疯狂触发生成。任何会被轮询执行的匹配逻辑,设计时必须做增量输入审查。

### 流式期间写回 message.mes 的竞态模型

- **只有"流式目标楼"(chat 最后一楼)的 mes 会被 ST 流式持续重写**——中途往它写 wrapper 会被下一个 chunk 冲掉;非流式楼层不受影响,随时可写。所以写回逻辑要按"目标楼是否正在被流式重写"分层,**不能顶层 isStreamActive 一票否决**(否则事件异常时媒体永久滞留)。
- **异步长任务(生成 40s+)会跨越流式生命周期**:触发在流式中、完成可能在流式结束后(或反之)。收尾不能只信任单一事件链(GENERATION_ENDED 防抖),完成回调要带独立的延迟重试兜底(本插件 10s)。
- **in-flight 落地三要素**:promptHash(对账)+ floor(触发楼层,非最后一楼)+ originalTag(标签原文)——生成耗时期间楼层结构会变,只记 hash 不记位置就是"图库有记录但零落地"。

### 消息数据三层模型与证据链定位

排障时先分清证据在哪一层,再交叉定位断点:

| 层 | 特性 | 可查证据 |
|---|---|---|
| `context.chat[i].mes` | 数据层,wrapper 存原始 `class="mag-media"` | 仅运行时可读(模块作用域,不在 window) |
| `.mes_text` DOM | 渲染层,sanitizer 加 `custom-` 前缀、自定义标签(`<StatusPlaceHolderImpl>` 等)会展开,textContent 远大于 mes 长度 | playwright 可读,但**不能当 mes 真值** |
| `data/<user>/chats/**.jsonl` | 持久层,**首行是 chat_metadata 不是消息**(楼层索引偏移 1);swipe 时 mes=当前分支、swipes 数组存其余分支 | 文件直读;**mtime 判断"内存事故是否落盘"**;每行一个 JSON |

辅助证据源:图库 `galleryManifest.timestamp` = 生成成功的独立产物记录(在 inFlightMedia.set 之后一行 push,**有图库条目 = 生成成功且已暂存**,断点必在落地段);ComfyUI `/queue` `/history` = 后端实际调用;`data/<user>/settings.json` 直读 extension_settings(绕过 window 不可达)。

### 正则的两种存在形态与转义边界

- **正则字面量**(`/...\/gi` 直接 const,如 MAG_MEDIA_WRAP_RE)无转义问题;**配置字符串**(存 settings、走 `regexFromString` 解析,如 imageRegex)在源码字符串字面量里必须**双反斜杠**——单反斜杠经 JS 解析 `\s`→`s`、`\b`→退格符,正则沉默失效(历史默认正则坏在这里从未生效,用户实际一直在用 UI 手配值)。
- 验证方法:node 一行 `eval` 该字符串字面量打印解析值,再拿真实数据 matchAll——不要信肉眼。
- **HTML 属性值是转义过的**(`data-prompt` 里 `"` → `&quot;`):插件内回读用 `unescapeHtmlAttr`;但 ST Regex 只做字符串替换**不会 unescape**,还原给 LLM 的 prompt 里实体会原样出现(SD tag 场景概率低,已知边界)。

### ST Regex 扩展(出口还原的承接方)

- Find Regex 输入走 `regexFromString` 解析——支持 `/pattern/flags` 字面量格式;Replace 用 `$1` 反向引用。
- **Only Format Prompt(promptOnly)**:只改发送给 LLM 的 prompt,不动 mes / 不动显示——正是 wrapper 出口还原要的语义。
- 匹配 wrapper/占位符要用 **lookahead 双锚点**(`(?=[^>]*data-media-type="...")(?=[^>]*data-prompt="...")`)取属性:media wrapper 与 placeholder 的**属性顺序不同**,不能按顺序捕获。

## ST 前端踩坑笔记

写浮层 / 拖动 UI 时一定会踩的坑,提前规避:

- **`dragElement($el)`(`scripts/RossAscends-mods.js:477`)不能用于内嵌浮窗的标题栏**。它强依赖 `.drag-grabber` 类,而 ST 全局 CSS 在 `style.css:790` 强制 `.drag-grabber { position: absolute; }`,会把标题栏从文档流中拔出、叠到下方控件上(本插件曾导致关闭按钮盖住下方 checkbox)。仅适用于 ST 自带 movingUI 浥浮工具栏。需要可拖动浮窗时自写 `mousedown`/`touchstart`(参考本插件 `initPanelDrag` / `initFloatBtnDrag`)。还有:它把位置写进 `power_user.movingUIState`、`power_user.movingUI === false` 时直接 abort、`isMobile()` 时禁用 — 三层耦合都不适合第三方常驻浮层。

- **jQuery `.toggle()` 对 `display:flex` 元素会强制变成 `display:block`**。用 `.css('display', 'flex' / 'none')` 显式控制,不要用 `.toggle()` / `.show()`。

- **手机端触摸拖动必须给拖动目标加 CSS `touch-action:none`**(浮标与浮窗标题栏都加了,settings.html)。不加时浏览器把触摸当滚动手势接管,touchmove 流被 `touchcancel` 打断 → "拖不动/拖一半卡死"(2026-08 实测:浮标吸附到屏幕边后手机上拖不出来)。`preventDefault` 救不了——document 级 touch 监听在现代浏览器默认 passive,jQuery `$.on` 又不支持传 passive 选项;监听清理也要把 `touchcancel` 与 `touchend` 并列。另:手机浏览器地址栏收展/旋屏会改 `innerHeight`,拖动时钳制过的位置会整个出屏——恢复落盘位置与 resize/orientationchange 都要再钳一次(本插件 `clampFloatBtnIntoView`)。

- **`saveSettingsDebounced` 实际防抖 1000ms**(`debounce_timeout.relaxed`,见 `scripts/constants.js:14`)。验证位置/设置持久化时,改完至少等 1s 再刷新,否则保存还没落盘。需要立即 flush(如显式"保存"按钮)用 `saveSettings()`(`script.js:7819`),无防抖。

- **`data-i18n` 默认替换整个 textContent,会把子元素吃掉**。`i18n.js:152-167` 的 `translateElement` 对没带属性前缀的 key 执行 `element.textContent = localizedValue`,这会**清空**元素里所有子节点(包括 `<i class="fa-...">` 图标),只留翻译后的文字。本插件曾导致 `+` 新建按钮显示成"最新"文字、`<i>` 图标消失。**正确做法**:只想翻译属性(tooltip 等)保留 innerHTML,用 `data-i18n="[title]key"` 语法(`[attr]key` 前缀只改属性);内层包一个 `<span data-i18n="key">text</span>` 也可以让 textContent 替换局限在 span 内,不影响同级的 `<i>`。

- **ST 全局 i18n 字典优先级 > 插件 zh-cn.json**。简单 key 名(单字/常见词如 `"New"`、`"Save"`、`"Delete"`)会被全局字典覆盖,插件的翻译不生效(本插件 `"New": "新建"` 没生效,因为全局翻成 `"最新"`)。**防御措施**:插件 i18n key 加独特后缀(如 `"New Preset"` 而非 `"New"`、`"comfy_save"` 而非 `"Save"`)。

- **`extension_settings` 是模块作用域变量,不在 `window` 上**。Playwright `browser_evaluate` 读不到 `window.extension_settings`。验证持久化只能"改 → 等 1s → 刷新 → 读 DOM"(或直接读文件 `data/default-user/settings.json`)。

- **Playwright 自动化 ST 编辑消息框,原生 `ta.value=` 赋值会静默失败**。ST 用 jQuery 管理 `.edit_textarea`,保存按钮是 **`.mes_edit_done`**(不是 mes_edit_save),正确姿势:`$(ta).val(新值).trigger('input')` → `$(mes块.querySelector('.mes_edit_done')).trigger('click')`。原生赋值后点保存:jQuery 读到空值,消息内存态被清空(文件未落盘,刷新可恢复)。另外合成 `click()` 对部分 ST 按钮不生效时改用 `$(el).trigger('click')`。整页刷新(navigate)后 ST 不恢复聊天,处于无聊天状态——测完要重新点角色卡进聊天,否则"最后一楼"相关验证全部对着欢迎页跑。

- **`GENERATION_STARTED` 无条件 emit(连 dryRun 也发),`GENERATION_ENDED` 唯一 emit 点是 `hideStopButton()`(`script.js:3477`)且带 NOOP 保护(停止按钮从未显示过就不发)**。装了 ST-Prompt-Template / QR2 之类会发 `Generate(..., dryRun=true)` 组装 prompt 的扩展时,dryRun 调用会把依赖 STARTED 的"流式中"状态拉起且永远等不到 ENDED;更阴的是真实生成的 ENDED 落地窗口期(本插件 200ms 防抖)常被紧随其后的 dryRun STARTED 覆盖 → `isStreamActive` 重新拉真 → 媒体永久滞留 + 500ms 轮询永转 + 3 分钟冷却到期对旧标签无限重复触发生成(2026-08 实测:烧 ComfyUI 三轮同图)。**防御双保险**:① STARTED 回调查第 3 个参数 `dryRun` 为 true 直接 return(顺带避免 dryRun 误清 `processingHashes` 并发锁);② 流式轮询里盯 `body.dataset.generating`(`deactivateSendButtons` 设 'true' / `activateSendButtons` 删),用"曾见 true 后被删"门槛(UI 锁定晚于 STARTED,直接判空会在 prompt 构建期误判)检测 ENDED 丢失,自行按流式结束收尾。

## Git

- 远程:`git@github.com:4312311/media-auto-generation.git` (SSH)
- 开发建议在 `dev` 分支,避免 main 上堆积未提交改动导致以后真正想 pull 时冲突

## 测试要点

改完后至少验证:
1. 图片模式(`[image]...[/image]`)→ 是否替换、是否走缓存;漏闭合(`[image]prompt` 行尾无 `[/image]`)兜底是否触发
2. 视频模式(`[video]...[/video]`)→ 是否替换
3. 流式模式 → 流式期间提前触发生成(500ms 轮询只触发不改 DOM,固定行为无开关),流式结束统一替换
4. 角色特征注入 → 命中角色名后是否附加 tag
5. 冷却逻辑 → 同一 prompt 3 分钟内不重复生成
6. ST Regex 还原规则配置后,发 LLM 的上下文里 wrapper 被还原成 `[image]prompt[/image]`(聊天记录与显示不变)
