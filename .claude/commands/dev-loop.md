---
description: 完整开发闭环 - 需求澄清 → 调研 → 设计 → 实现 → 自测 → 端到端验证 → 代码审查
argument-hint: <任务描述,例如 给插件加暂停生成的按钮>
---

你要对插件执行一次完整开发闭环。任务描述:`$ARGUMENTS`

按下面 8 个阶段(0-7)执行,**不要跳步**。每个阶段结束用一行 `[阶段 N 完成] <一句话总结>` 汇报,然后继续下一阶段,除非遇到必须用户决策的点。

---

## 阶段 0 — 需求澄清

用户给的 `$ARGUMENTS` 通常是粗略需求,**不要直接进调研**。先用这个阶段把需求搞清楚:

- 用你自己的话**复述**任务,至少说清:
  - **验收标准**:做完后用户怎么验证对了?(具体到能点哪个按钮、看到什么)
  - **边界**:做什么 / 不做什么(明确排除项)
  - **隐含假设**:你假设了什么?(比如"沿用现有缓存逻辑"——列出来让用户确认或否定)
- 不确定的点**一次性**用 `AskUserQuestion` 问完(2-4 个问题,不要挤牙膏式一个个问)
  - 每问给 2-4 个选项,推荐项放第一个并标"(推荐)"
  - 选项里要有具体场景而非空泛词(比如"按钮放在设置抽屉顶部"而不是"放在合适位置")
- **涉及 UI 改动/新增组件时,务必确认两个易漏点**(本次踩过坑):
  - **空状态行为**:列表/表单为空时,输入框是 disabled(必须先点 + 新建才能编辑)还是 enabled(输入即自动建默认项)还是整段隐藏只显示一个大 [+ 新建] 按钮?默认推荐哪一种?
  - **保存时机**:实时保存(每键击/失焦自动落盘,加显式"保存"按钮作心理锚点)还是只在点保存按钮时落盘?
- **退出条件**:你能用一句话讲清"做完后用户验收什么",且用户明确回复"需求 OK"/"开始吧"/"继续"
- 用户没确认前**严禁**进入阶段 1,严禁读代码、写代码

## 阶段 1 — 调研

- 用 Glob/Grep 搜本目录,定位与任务相关的文件和函数
- 读 CLAUDE.md 的"代码地图"找入口
- 必要时用 Explore 子代理做大范围搜索
- 输出: **影响范围清单**(哪些文件/函数要动,哪些不能动)

## 阶段 2 — 设计

- 进入 Plan 模式(`EnterPlanMode`),不要直接写代码
- 产出实现方案:数据结构、控制流、UI 改动、与现有事件/缓存的交互
- **复用 ST 工具前先查 CSS 耦合**:很多 ST 工具(`dragElement`、movingUI、各种 dialog)依赖某 class 触发的全局 CSS(`.drag-grabber` / `.inline-drawer-toggle` 等),这些 class 可能强制改 `position` / `display` / 浮层挂载点,直接套用会破坏周边布局。设计前 grep 一遍 `style.css` 看是否有匹配的 class 规则,有就走自写方案。详见 CLAUDE.md "ST 前端踩坑笔记"。
- 关键决策点用 `AskUserQuestion` 让用户选(默认推荐项放第一个,加"(推荐)")
- 用户批准后用 `ExitPlanMode` 退出

## 阶段 3 — 任务拆解

- 用 `TaskCreate` 把方案拆成 3-7 个可独立验证的子任务
- 复杂依赖用 `addBlockedBy` 串起来
- 严禁"一个任务改 5 个文件"这种粗粒度,每个任务应能独立测试

## 阶段 4 — 实现

- 逐个 claim 任务,`TaskUpdate` 设 `in_progress`,做完设 `completed`
- 严格按方案改,**不要顺手"清理"周边代码**(除非用户要求)
- 改动遵循 CLAUDE.md 的代码风格(ES Module、jQuery 风格、ST 事件系统)
- 不要加未要求的注释、错误处理、向后兼容
- **字段闭环核对(收尾必跑)**:阶段 2 设计里若定义了数据结构(如 `Entry { url, character, prompt, timestamp, ... }`),把每个字段名 grep 一遍,确认**每个 push / 构造点都设了所有字段**。漏字段往往不会报错——只会在 sort / filter / 渲染时悄悄塌成默认值,等 `/simplify` 才抓到。典型坑:`{ ..., timestamp }` 计划写了但 push 时只传 5 个字段,sort 全部归 0。

## 阶段 5 — 自测

- **静态检查**: `node --check index.js` 验证语法
- **回归点**: 至少跑 CLAUDE.md "测试要点"列的 5 个场景中受影响的部分
- 后端调用失败时读 `/Users/zy/game/SillyTavern-Launcher/SillyTavern/logs/` 下的日志

## 阶段 6 — 端到端验证(Playwright MCP)

**前置探活**(避免对着挂掉的后端点半天按钮):
```bash
# ST 必跑
lsof -i :8000 -sTCP:LISTEN >/dev/null && echo st_ok || echo st_down
# 涉及 SD/ComfyUI 时探后端(改 host/port 按你环境)
curl -s -m 2 http://127.0.0.1:8188/system_stats >/dev/null && echo comfy_ok || echo comfy_down
```
任一 `*_down` 直接告知用户"端到端阻塞,启动 X 后再跑,或走降级路径",不要继续闷头操作。

按 CLAUDE.md "标准调试协议"步骤 1-6 走一遍:
1. `lsof -i :8000 -sTCP:LISTEN` 确认 ST 在跑;没跑提示用户启动
2. playwright navigate 打开 `http://localhost:8000`
3. 触发一次复现路径(发消息或重新加载聊天)
4. 读 console,过滤 `[media-auto-generation]` 前缀和堆栈含 `extensions/third-party/media-auto-generation` 的报错
5. 有报错回到阶段 4 修
6. 行为符合预期 → 截图作为证据

**回归测试降级路径**:若回归场景需要重 UI 上下文(已在某角色卡聊天中 + SD/ComfyUI 后端连通 + image/video 模式已开),从冷启动 Playwright 配齐成本远超回归风险时,允许用"结构论证"替代端到端触发:
- 改动文件 `node --check` 语法 OK
- grep 确认未触动代码路径仍完整(如本插件的事件监听器 `eventSource.on(...)` 仍在)
- 改动后 console 0 报错
- 把"为什么这次改动不可能影响 X 功能"用一句话讲清(比如"UI 重构未触核心生成逻辑")
满足这四条即可视为回归通过,在阶段汇报里写明用了降级路径即可。

若 Playwright MCP 不可用,改走 CLAUDE.md 的"手动回退",让用户操作 + 复制 console。

## 阶段 7 — 代码审查

- 调用 `/simplify` 审查本次改动,自动修掉冗余/质量问题
- 输出最终 diff 摘要:动了哪些文件,为什么

## 阶段 8 — 提交并推送(自动)

阶段 7 完成后自动跑,**无需用户确认**。用户通过 `/dev-loop` 调用本命令即视为对此步骤的显式授权(覆盖默认的"必须显式要求才 commit / push"协议)。

### 判定有无改动

并行跑 `git status` / `git diff`(staged + unstaged)/ `git log -5 --oneline`:

- **无改动**(working tree clean)→ 跳过本阶段,最终输出标"无改动,跳过 commit"
- **有改动** → 进入下方提交流程

### 提交流程

1. 对照阶段 7 输出的"改动文件"清单,**只 add 本次任务真正动过的文件**(具体文件名,**禁止** `git add -A` / `git add .`,避免误带 `.env` / `logs/` / 无关 `*.json`)
2. 按 `git log` 最近风格起草**简短中文** message:动作(Add / Update / Fix / Refactor)+ 一句话讲清本次任务做了什么(参考 `$ARGUMENTS`)。参考最近提交:`Add 测试生成 tab:聊天外用当前 ComfyUI 配置档生图测试`
3. message 末尾按 Claude Code 标准 commit 协议加 `Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>` 行
4. 用 HEREDOC 传 message(`git commit -m "$(cat <<'EOF' ... EOF\n)"`)避免多行格式错乱
5. `git push`(默认推到**当前分支**的 upstream,**不**主动加 `-u`)
6. push 失败提示 "no upstream branch" → 停下问用户,**不**擅自加 `-u origin <branch>`(可能误推错分支名)
7. push 失败提示 "non-fast-forward" → 停下问用户,**禁止** `--force`,按系统 prompt 的冲突处理流程解决

### 安全护栏(永远不做)

- `git commit --amend`(永远新建 commit)
- `git push --force` / `--force-with-lease`,推 main 时尤其禁止
- `--no-verify` / `--no-gpg-sign` 等 skip 开关
- 把 `.env` / `*.credentials.json` / 文件名或内容含 `api_key` / `token` / `secret` 的文件加入 commit
- commit 与本次 `$ARGUMENTS` 无关的"顺手清理"改动(发现无关改动多 → 停下问用户)

---

## 全部完成后输出

```
✅ dev-loop 完成
- 任务: $ARGUMENTS
- 改动文件: <list>
- 子任务: <completed count>
- 端到端验证: 通过/失败
- 审查: 通过/待处理
- 提交: <短 hash> <message 首行> / 无改动跳过
- 推送: 已推送到 origin/<branch> / 失败原因 / 跳过
```
