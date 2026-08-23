// 媒体自动生成插件主脚本 - 最终完善版
// 修复并发显示 + 优化进度提示逻辑（移除误导性的总数显示）

import { extension_settings, getContext } from '../../../extensions.js';
import {
    saveSettings,
    saveSettingsDebounced,
    eventSource,
    event_types,
    updateMessageBlock,
    getRequestHeaders,
} from '../../../../script.js';
import { regexFromString, clamp, getUniqueName, saveBase64AsFile, copyText } from '../../../utils.js';
import { isMobile } from '../../../RossAscends-mods.js';
import { callGenericPopup, POPUP_TYPE, POPUP_RESULT } from '../../../popup.js';
import { translate } from '../../../i18n.js';

const extensionName = 'media-auto-generation';
const extensionFolderPath = `/scripts/extensions/third-party/${extensionName}`;

// --- 全局状态管理 ---

let isStreamActive = false;
let streamInterval = null;
let updateDebounceTimer = null; 

// 失败记录 (Key: Hash -> Value: errorMessage):自动模式 ComfyUI 失败时记录,流式结束后渲染 error 占位符让用户重试
const failedPrompts = new Map();

// 自动模式 IIFE 完成 → landInFlightMedia() 落地 DOM 的中转暂存。
// value: { mediaTag, declare, floor, originalTag, regexStr }
//   - declare:触发时刻从 mes 捕获的紧邻 <pic_Declare> 描述,供流式期间的媒体预览浮窗显示
//   - floor / originalTag:触发时的楼层号与标签原文。生成耗时 40s+,完成时该楼可能已不是
//     最后一楼(用户已发下一条)——落地按它们精确定位,不依赖"恰好是最新楼"
//   - regexStr:触发时用的标签正则,originalTag 失配时(用户 regex 脚本改写了 mes)按 hash 重扫兜底
// 消费一次就 delete,因此**跨消息不复用**(每次同 prompt 都重新生成)。
// 手动模式 / 重生成走 magId 直接替换,不经此 map。
const inFlightMedia = new Map();

// 2. 历史记录 (冷却锁)
const promptHistory = new Map();

// 3. 并发处理锁 (生成锁)
const processingHashes = new Set();

// 冷却时间设置：3分钟
const PROMPT_COOLDOWN_MS = 180000;

// 默认设置 (新增 characterTags)
const defaultSettings = {
    mediaType: 'disabled',
    // BBCode 式触发标签(成对优先,漏闭合时按行内内容兜底):
    // 分支1 [image]prompt[/image] —— 组1=prompt,体内非贪婪到闭合标签,引号/换行/[ 权重语法都不是结构性字符
    // 分支2 [image]prompt        —— 组2=prompt,AI 漏写 [/image] 时取行内内容(到换行或 [ 止)
    // 旧 <pic prompt="..."> 属性式格式已废弃,不做兼容(存量聊天未生成标签不再触发)
    imageRegex: '/\\[image\\][ \\t]*([\\s\\S]*?)[ \\t]*\\[\\/image\\]|\\[image\\][ \\t]*([^\\n\\[]+)/gi',
    videoRegex: '/\\[video\\][ \\t]*([\\s\\S]*?)[ \\t]*\\[\\/video\\]|\\[video\\][ \\t]*([^\\n\\[]+)/gi',
    style: 'width:100%;height:auto',
    autoReplace: 'auto', // 'auto'=匹配后自动生成替换;'manual'=渲染成可点击占位符,手动点击触发生成
    characterTags: {}, // --- 新增: 角色固定特征字典 ---
    floatBtnPosition: null, // 浮动按钮位置 { left, top },null=默认右下角
    comfyPresets: [], // ComfyUI 配置档列表
    activePresetName: null, // 当前激活的配置档名字
    activeComfyUrl: '', // 全局激活的 ComfyUI 服务地址(跨 preset 共享)
    comfyUrls: [], // ComfyUI 服务地址簿(跨 preset 共享):[{ name, url }]
    comfyListCache: {}, // 点『连接』拉到的列表持久化(按地址分档):{ [url]: { models, samplers, schedulers, loras, upscaleModels, savedAt } }
    comfyImportUrls: [], // detail 接口 URL 历史(拉取成功后自动入簿):[string]
    galleryManifest: [], // 图库:本插件生成过的图片/视频记录,按角色卡分组展示
};

function simpleHash(str) {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
        hash = (hash * 33) ^ str.charCodeAt(i);
    }
    return (hash >>> 0).toString(16);
}

function normalizePrompt(str) {
    if (!str) return "";
    return str.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * 从触发正则的 match 里提取 prompt(三处扫描点共用)。
 * 新正则两分支各一组捕获:组1=[image]...[/image] 成对分支,组2=漏闭合行内兜底分支。
 * 体内是自然语言,引号/换行都不是结构性字符;此处把换行折叠成空格,
 * 保证存进 wrapper data-prompt / 展示 / ST Regex 还原出去的都是单行干净文本。
 */
function extractTagPrompt(m) {
    return ((m[1] ?? m[2]) || '').trim().replace(/\s+/g, ' ');
}

function pruneOldPrompts() {
    const now = Date.now();
    for (const [hash, timestamp] of promptHistory.entries()) {
        if (now - timestamp > PROMPT_COOLDOWN_MS) {
            promptHistory.delete(hash);
        }
    }
}

function escapeHtmlAttribute(value) {
    if (typeof value !== 'string') return '';
    // 换行一并实体化:占位符/wrapper 的属性值(data-original-tag 存标签原文)若含裸换行,
    // mes 会被撕成多行 → ST 渲染管线按行处理(fixMarkdown 给奇数引号行行尾补 "、showdown
    // 按行切块)把 HTML 撕碎 → 整段占位符被当纯文本渲染成源码(2026-08 video 多行 prompt
    // 事故:image 测试 prompt 单行所以"看起来正常",video 的多行分镜稿必炸)。
    // 属性值里的 &#10;/&#13; 浏览器解析时还原为换行,DOM attr() 读回原文,无副作用。
    return value
        .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
        .replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/\r/g, '&#13;').replace(/\n/g, '&#10;');
}

/**
 * 字面量替换:replacement 不解释 $ 语义。
 * String.prototype.replace 的字符串 replacement 里 $&/$`/$'/$$ 有特殊含义——
 * 占位符/wrapper HTML 内嵌用户 prompt,prompt 含 `$` 序列时会被展开成正文片段,破坏 HTML。
 */
function replaceLiteral(str, search, repl) {
    return str.replace(search, () => repl);
}

/**
 * 判断 text 中 index 位置是否落在 HTML 标签内部(< 之后、> 之前的标签/属性区)。
 * 占位符的 data-original-tag、wrapper 的 data-prompt 属性里存着裸标签原文/用户 prompt,
 * 正则扫描的是整个 mes 文本,分不清"正文里的裸标签"和"属性里存的标签文本"——
 * 重扫(进聊天全量扫 / 编辑消息 / 流式结束扫最后一楼)会把属性里的 [image]...[/image]
 * 再当正文标签匹配,把新占位符的完整 HTML 未转义塞进旧占位符的属性值 → 嵌套损坏,
 * 渲染成源码文本(2026-08 实测:image/video 均中招,首次落地正常、重进聊天后损坏)。
 * 判定:index 前最近的 '<' 比最近的 '>' 更近 = 位于标签内部。
 */
function isInsideHtmlTag(text, index) {
    const lt = text.lastIndexOf('<', index - 1);
    const gt = text.lastIndexOf('>', index - 1);
    return lt > gt;
}

/**
 * 修复嵌套损坏的占位符(存量自愈):占位符 data-original-tag 属性值被塞进了另一份
 * 完整占位符 HTML(见 isInsideHtmlTag 注释的成因)时,把属性值剥回内层记录的裸标签原文。
 * 外层占位符的其余部分(子元素/属性)保持不变,每轮剥一层,循环到无嵌套或 10 轮上限。
 * 注:三层以上嵌套(连续多次重扫累积,守卫上线后不会再发生)只能保证不再嵌套,
 * 可能残留属性尾巴文本碎片——极端存量建议直接删楼/编辑该消息。
 */
const NESTED_ORIG_TAG_RE = /data-original-tag="(<span\b[\s\S]*?data-original-tag="(\[[^"]*\])"[\s\S]*?<\/span>)"/g;
function healNestedPlaceholders(mes) {
    if (typeof mes !== 'string' || !mes.includes('data-original-tag="<span')) return mes;
    let out = mes;
    for (let round = 0; round < 10; round++) {
        const next = out.replace(NESTED_ORIG_TAG_RE, (_m, _inner, bareTag) => `data-original-tag="${bareTag}"`);
        if (next === out) break;
        out = next;
    }
    return out;
}

/**
 * 修复 mag 属性值里的裸换行(存量自愈):旧版 escapeHtmlAttribute 不转义换行,
 * 多行 prompt 的 data-original-tag/data-prompt 属性值跨 N 行,被 ST 渲染管线
 * (fixMarkdown 奇数引号行行尾补 " / showdown 按行切块)撕碎 → 占位符渲染成源码。
 * 新落地已由 escapeHtmlAttribute 治本,此函数只修历史楼。
 */
const MULTILINE_MAG_ATTR_RE = /(data-(?:original-tag|prompt|error)=")([^"]*)"/g;
function healMultilineMagAttrs(mes) {
    if (typeof mes !== 'string' || !mes.includes('data-mag-id=')) return mes;
    return mes.replace(MULTILINE_MAG_ATTR_RE, (m, attr, val) =>
        (/[\r\n]/.test(val) ? attr + val.replace(/\r/g, '&#13;').replace(/\n/g, '&#10;') + '"' : m));
}

/**
 * 占位符存量损伤统一自愈入口:先修嵌套(嵌套楼属性值里含未转义引号,多行正则会
 * 在内层引号截断,必须先修净),再把属性值里的裸换行实体化。
 */
function healPlaceholderDamage(mes) {
    return healMultilineMagAttrs(healNestedPlaceholders(mes));
}

/**
 * 全楼扫一遍存量自愈(自动模式专用入口;手动模式的 heal 走
 * processAllMessagesForPlaceholders 内联)。修复过的楼层重渲 + 落盘。
 * @returns {Promise<number>} 修复的楼层数
 */
async function healAllFloorsNestedPlaceholders() {
    const context = getContext();
    const chat = context.chat || [];
    const healed = [];
    for (let i = 0; i < chat.length; i++) {
        const message = chat[i];
        if (!message || message.is_user || typeof message.mes !== 'string') continue;
        const fixed = healPlaceholderDamage(message.mes);
        if (fixed !== message.mes) {
            message.mes = fixed;
            updateMessageBlock(i, message);
            healed.push(i);
        }
    }
    if (healed.length > 0) {
        for (const i of healed) {
            await eventSource.emit(event_types.MESSAGE_UPDATED, i);
        }
        try { await context.saveChat(); } catch (e) { console.error(`[${extensionName}] saveChat failed:`, e); }
        console.warn(`[${extensionName}] 已修复占位符存量损伤(嵌套/多行属性): 楼层 ${healed.join(', ')}`);
    }
    return healed.length;
}

// mag-media wrapper 匹配(collectFloorMedia 楼层扫描用)。
// mes 里 class 是原始 `mag-media`(DOMPurify 渲染到 DOM 时才加 custom- 前缀,不会写回 mes),防御性同时匹配;
// wrapper 外层是单 <span> 无嵌套 <span>,所以 [\s\S]*?</span> 必然匹配到正确闭合。
const MAG_MEDIA_WRAP_RE = /<span\b[^>]*\bclass\s*=\s*"[^"]*\b(?:custom-)?mag-media\b[^"]*"[^>]*>[\s\S]*?<\/span>/gi;

// declare 描述块(collectFloorMedia 楼层扫描 / processMessageContent 捕获流式 in-flight 媒体的 declare 共用)。
// 兼容三种格式:① [img_Declare]...[/img_Declare] ② [video_Declare]...[/video_Declare](图片/视频各自带 declare 时用,
// 2026-08 起用户角色卡的 BBCode 格式)③ <pic_Declare>...</pic_Declare>(旧卡,存量聊天兼容)。
// 开/闭标签用交替而非两组捕获 → 单捕获组,declareForPosition 的 d[1] 取值不用分支。
// matchAll 内部克隆正则,共享 const 无 lastIndex 残留问题。
const PIC_DECLARE_RE = /(?:\[(?:img|video)_Declare\]|<pic_Declare>)([\s\S]*?)(?:\[\/(?:img|video)_Declare\]|<\/pic_Declare>)/gi;

// 游离 data-mag-role 元素(LLM 伪造尾巴的构成部分):
// ① 紧闭合的完整元素(内容里不许再出现 small/i 标签,防止未闭合的开标签跨元素误吞正文)连同内容一起删;
// ② 剩下的未闭合开标签只删标签本身,保住被它吞掉的正文。
const MAG_ROLE_ELEMENT_RE = /<(small|i)\b[^>]*\bdata-mag-role\b[^>]*>(?:(?!<\/?(?:small|i)\b)[\s\S])*?<\/\1\s*>/gi;
const MAG_ROLE_OPEN_RE = /<(?:small|i)\b[^>]*\bdata-mag-role\b[^>]*>/gi;
// 未能折叠(缺 data-media-type/data-prompt 等属性不齐)的假壳/占位符开标签,兜底剥掉
const MAG_SPAN_OPEN_RE = /<span\b[^>]*\bclass\s*=\s*"[^"]*\bmag-[^"]*"[^>]*>/gi;

/**
 * 中和 LLM 伪造的 mag-* HTML(它模仿 wrapper 格式写的假壳 + 模仿尾巴),入口防御。
 * 只对"本轮新生成的内容"调用(新楼全量 / continue 只处理追加段)——插件自己落地的
 * wrapper 只会出现在这些位置之外,因此无需区分真假:
 * - mag wrapper/占位符 span 开标签 → 剥掉(遗留的孤立 </span> 浏览器解析时无害;
 *   LLM 侧的 wrapper 还原由 ST Regex 扩展承担,见 README)
 * - 紧闭合的 data-mag-role 元素 → 连内容删(prompt 文本 + 按钮文字都是 UI 碎片)
 * - 未闭合的 data-mag-role 开标签 → 只删标签本身,保住被它吞的正文(未闭合 <small> 会让
 *   后续文字逐层变小变暗,正是"图片后文字越来越小+蒙层叠加"渲染事故的根源)
 * 剥完后内部的 [image]/[video] 标签原样保留,继续走正常生成管线(假壳里抄来的 prompt 也能
 * 借此重新生成真图)。
 */
function sanitizeLlmMagHtml(text) {
    if (typeof text !== 'string' || !/<(?:span|small|i)\b[^>]*mag-/i.test(text)) return text;
    return text
        .replace(MAG_SPAN_OPEN_RE, '')
        .replace(MAG_ROLE_ELEMENT_RE, '')
        .replace(MAG_ROLE_OPEN_RE, '');
}

// 生成开始时的最后楼 mes 快照(入口防御用):结束时据此区分"新楼/swipe 重写"(全量中和)
// 与"continue 追加"(只中和追加段——前缀里可能有插件此前落地的真 wrapper,不能误伤)。
let preGenerationMesSnapshot = null;

/**
 * AI 消息落地时中和 LLM 伪造的 mag-* HTML。
 * 时机:MESSAGE_RECEIVED / GENERATION_ENDED(STOPPED) —— 插件要等这之后才写占位符和
 * wrapper,此刻 mes 里的 mag-* HTML 必然是 LLM 写的,判据无歧义。编辑/切聊天的重扫路径
 * 不调用(存量楼层不动,交给用户决定)。
 */
async function sanitizeFreshLlmMessage() {
    const context = getContext();
    const chat = context.chat;
    if (!Array.isArray(chat) || chat.length === 0) return;
    const lastIndex = chat.length - 1;
    const message = chat[lastIndex];
    if (!message || typeof message.mes !== 'string') return;

    let cleaned;
    const snap = preGenerationMesSnapshot;
    if (snap && snap.index === lastIndex && typeof snap.mes === 'string') {
        if (message.mes === snap.mes) return; // 生成了但没追加内容(立即中断),别碰可能有真 wrapper 的旧内容
        if (message.mes.startsWith(snap.mes)) {
            // continue:只处理追加段
            cleaned = snap.mes + sanitizeLlmMagHtml(message.mes.slice(snap.mes.length));
        }
    }
    if (cleaned === undefined) cleaned = sanitizeLlmMagHtml(message.mes);
    if (cleaned === message.mes) return;

    console.warn(`[${extensionName}] 已剥离 LLM 伪造的 mag-* HTML(楼层 ${lastIndex})`);
    message.mes = cleaned;
    updateMessageBlock(lastIndex, message);
    await eventSource.emit(event_types.MESSAGE_UPDATED, lastIndex);
    try { await context.saveChat(); } catch (e) { console.error(`[${extensionName}] saveChat failed:`, e); }
}

/**
 * 把 message.mes 中 data-mag-id 匹配的占位符 span 替换为 newTag。
 * 占位符 HTML 结构约定:外层只有一个 <span>(无嵌套 span),所以非贪婪 </span> 必然匹配到正确闭合。
 */
function replacePlaceholderInMes(mes, magId, newTag) {
    const escaped = escapeRegExp(magId);
    const re = new RegExp(`<span[^>]*data-mag-id="${escaped}"[^>]*>[\\s\\S]*?</span>`, '');
    return replaceLiteral(mes, re, newTag);
}

/**
 * 反查包含指定 magId 的消息 index。
 * magId 以 data-mag-id="<magId>" 字面量持久化在 message.mes 里,倒序找(最近消息优先),找不到返回 -1。
 *
 * 手动生成/重生成时,点击的占位符可能不在最后一条消息里(比如更早楼层),不能用 chat.length-1 兜底,
 * 必须按 magId 锚定真实消息,否则会改错消息 → 占位符不替换且 loading 转圈不消失。
 */
function findMessageIndexByMagId(magId) {
    const context = getContext();
    const needle = `data-mag-id="${escapeHtmlAttribute(magId)}"`;
    for (let i = context.chat.length - 1; i >= 0; i--) {
        const m = context.chat[i];
        if (m && typeof m.mes === 'string' && m.mes.includes(needle)) return i;
    }
    return -1;
}

/**
 * 按 magId 反查真实消息,把 mediaWrap 替换进该消息的 mes 并重渲当前块。
 * 手动生成 / 重生成共用:点击的占位符/wrapper 可能在任意楼层(非最后一条),
 * 必须按 magId 锚定真实消息,否则会改错消息 → 占位符不替换且 loading 转圈不消失。
 * @returns {Promise<boolean>} 是否成功定位并替换(失败仅 console.warn,不抛错)
 */
async function commitMediaToMessage(magId, mediaWrap, callerName) {
    const messageIndex = findMessageIndexByMagId(magId);
    const context = getContext();
    const message = messageIndex >= 0 ? context.chat[messageIndex] : null;
    if (!message) {
        console.warn(`[${extensionName}] ${callerName}: 找不到 magId=${magId} 对应的消息,跳过 DOM 替换`);
        return false;
    }
    message.mes = replacePlaceholderInMes(message.mes, magId, mediaWrap);
    updateMessageBlock(messageIndex, message);
    await eventSource.emit(event_types.MESSAGE_UPDATED, messageIndex);
    await context.saveChat();
    scheduleMediaPreviewRender(); // 手动/重生成落地 mes → 预览浮窗跟进刷新
    return true;
}

/** 把 timestamp 格式化为 YYYY-MM-DD HH:mm(用于图库缩略图下方时间显示) */
function formatGalleryTime(ts) {
    if (!ts || !Number.isFinite(ts)) return '';
    const d = new Date(ts);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// --- 新增: 核心注入工具函数 ---

// 正则转义工具，防止角色名中包含特殊符号导致正则报错
function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 角色特征自动注入逻辑
 * @param {string} rawPrompt 原始提示词
 * @param {object} tagsDict 角色特征字典
 * @returns {object} { modifiedPrompt: string, injected: boolean }
 */
function injectCharacterTags(rawPrompt, tagsDict) {
    if (!tagsDict || Object.keys(tagsDict).length === 0) return { modifiedPrompt: rawPrompt, injected: false };
    
    let modifiedPrompt = rawPrompt;
    let injected = false;
    
    for (const [charName, tags] of Object.entries(tagsDict)) {
        if (!charName.trim() || !tags.trim()) continue;
        
        // 使用单词边界 \b 进行精确匹配，忽略大小写 (gi)
        const regex = new RegExp(`\\b${escapeRegExp(charName)}\\b`, 'gi');
        
        if (regex.test(modifiedPrompt)) {
            // 将匹配到的名字替换为 "名字, 特征tag" 格式
            modifiedPrompt = modifiedPrompt.replace(regex, (match) => {
                return `${match}, ${tags}`;
            });
            injected = true;
        }
    }
    return { modifiedPrompt, injected };
}

// --- ComfyUI 直连工具函数 ---

/** 当前激活的配置档,失败返回 null */
function getActivePreset() {
    const s = extension_settings[extensionName];
    if (!s || !Array.isArray(s.comfyPresets)) return null;
    return s.comfyPresets.find(p => p.name === s.activePresetName) || null;
}

// ComfyUI 全局串行队列。ComfyUI 后端本身串行处理,客户端不串行的话 N 个并发 fetch 会
// 全挂在后端队列里,单次超时会被排队等待时间污染。这里强制前一个完成才发下一个。
let comfyChain = Promise.resolve();

/**
 * 把 task 串到 ComfyUI 全局串行队列。前一个 job 完成(成功/失败)才执行下一个。
 * 每个 job 拿到自己的结果/异常,互不阻塞。
 * @template T
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
function enqueueComfyJob(task) {
    // then 第二参数也是 task — 前一个 job 失败时不阻塞后续
    const next = comfyChain.then(task, task);
    comfyChain = next;
    return next;
}

/**
 * 通用 ComfyUI 代理调用,body 已含 url(+ 可选 auth),passthrough 给 /api/sd/comfy/<path>
 * @param {string} path ping/samplers/models/schedulers/vaes/generate(LoRA/放大模型列表不走代理,见 fetchLorasDirect / fetchUpscaleModelsDirect)
 * @param {object} body
 * @param {number} [timeoutMs=60000] 超时,超时后 abort 并抛"超时"错误
 * @param {AbortSignal} [externalSignal] 外部中断信号(手动模式"终止生成"):abort 时联动取消本请求,
 *   与超时 abort 的区分靠 err 消息("已被中断" vs "超时")。排队期间已 abort 的,fetch 发出前就会被取消。
 */
async function comfyProxy(path, body, timeoutMs = 60_000, externalSignal = null) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onExternalAbort = () => controller.abort();
    if (externalSignal) {
        if (externalSignal.aborted) controller.abort();
        else externalSignal.addEventListener('abort', onExternalAbort);
    }
    try {
        const res = await fetch(`/api/sd/comfy/${path}`, {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(body),
            signal: controller.signal,
        });
        if (!res.ok) {
            const text = await res.text();
            throw new Error(`ComfyUI ${path} failed: ${text}`);
        }
        return await res.json();
    } catch (err) {
        if (err.name === 'AbortError') {
            throw new Error(externalSignal?.aborted
                ? `ComfyUI ${path} 请求已被中断`
                : `ComfyUI ${path} 超时(${Math.round(timeoutMs / 1000)}s)`);
        }
        throw err;
    } finally {
        clearTimeout(timer);
        if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
    }
}

const VIDEO_FORMATS = new Set(['mp4', 'webm', 'mov', 'avi', 'mkv']);

/**
 * 浏览器直连 ComfyUI 拉 object_info 里某节点某参数的下拉选项列表。
 * 不走 ST 后端代理——要求 ComfyUI 启动带 --enable-cors-header(否则跨域请求被 Origin 校验 403)。
 * 兼容新版 object_info 的 ["COMBO",{options}] 与旧版的 [0] 数组两种返回结构。
 * @param {string} nodeName 节点 class_type(如 UpscaleModelLoader / LoraLoader)
 * @param {string} paramName 参数名(如 model_name / lora_name)
 * @param {string} comfyUrl ComfyUI 服务地址
 * @param {number} [timeoutMs=10000] 超时抛错
 * @returns {Promise<string[]>} 选项字符串数组
 */
async function fetchComfyComboOptions(nodeName, paramName, comfyUrl, timeoutMs = 10_000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const base = String(comfyUrl || '').trim().replace(/\/+$/, '');
        const res = await fetch(`${base}/object_info/${nodeName}`, { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const param = data?.[nodeName]?.input?.required?.[paramName];
        const list = Array.isArray(param?.[0]) ? param[0] : (Array.isArray(param?.[1]?.options) ? param[1].options : null);
        if (!Array.isArray(list)) throw new Error(`object_info 返回里没有 ${paramName} 列表`);
        return list.filter(n => typeof n === 'string');
    } catch (err) {
        if (err.name === 'AbortError') throw new Error(`ComfyUI object_info 超时(${Math.round(timeoutMs / 1000)}s)`);
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

/** 直连拉放大模型列表(models/upscale_models) */
function fetchUpscaleModelsDirect(comfyUrl, timeoutMs) {
    return fetchComfyComboOptions('UpscaleModelLoader', 'model_name', comfyUrl, timeoutMs);
}

/**
 * 直连拉 LoRA 列表(models/loras)。优先 LoraLoader(ComfyUI 核心自带);
 * 极简/魔改环境缺它时退回 LoraLoaderModelOnly,再不行抛错由调用方降级(手动输入文件名)。
 */
async function fetchLorasDirect(comfyUrl, timeoutMs = 10_000) {
    try {
        return await fetchComfyComboOptions('LoraLoader', 'lora_name', comfyUrl, timeoutMs);
    } catch {
        return fetchComfyComboOptions('LoraLoaderModelOnly', 'lora_name', comfyUrl, timeoutMs);
    }
}

/**
 * 工作流 JSON 中受插件支持的占位符清单。顺序即 popover 显示顺序。
 * 与 applyWorkflowPlaceholders 中的 replacements 字段保持一致。
 */
const SUPPORTED_PLACEHOLDERS = [
    'model', 'sampler', 'scheduler', 'width', 'height', 'steps',
    'scale', 'denoise', 'seed', 'prompt', 'negative_prompt',
];

let _wfValidateTimer = null;

/**
 * 工作流占位符替换。占位符在 JSON 里带引号("%key%"),用 JSON.stringify 自动转义。
 * @param {boolean} forceRandomSeed 强制随机 seed(楼层级重新生成用:固定 seed 下重生成结果与旧图几乎相同)
 */
function applyWorkflowPlaceholders(workflowJson, preset, prompt, negativePrompt, forceRandomSeed = false) {
    const seed = forceRandomSeed || !(Number.isFinite(preset.seed) && preset.seed >= 0)
        ? Math.floor(Math.random() * 1_000_000_000)
        : preset.seed;
    const replacements = {
        model: preset.model,
        sampler: preset.sampler,
        scheduler: preset.scheduler,
        width: preset.width,
        height: preset.height,
        steps: preset.steps,
        scale: preset.scale,
        denoise: preset.denoise,
        seed,
        prompt,
        negative_prompt: negativePrompt,
    };
    let workflow = workflowJson;
    for (const [key, value] of Object.entries(replacements)) {
        workflow = workflow.replaceAll(`"%${key}%"`, JSON.stringify(value));
    }
    return workflow;
}

/**
 * 生成时动态注入放大模型:在终端图像输出节点(PreviewImage / SaveImage / VideoCombine 等,
 * 即"输出没有被其他节点消费且带 images 节点引用输入"的节点)前插入 UpscaleModelLoader + ImageUpscaleWithModel。
 * 工作流已带接好线的放大链时只覆盖 loader 的 model_name(下拉选择优先),不重复插节点。
 * 同源终端共享一个放大节点,异源终端各插一个;找不到终端节点时原样返回(打 warn)。
 * JSON 解析失败也原样返回(占位符/结构问题交给后端报错)。
 * @param {string} workflowJson 占位符已替换完的工作流 JSON 文本
 * @param {string} modelName 放大模型文件名(preset.upscaleModel)
 * @returns {string} 注入后的工作流 JSON 文本
 */
function injectUpscaleIntoWorkflowJson(workflowJson, modelName) {
    let parsed;
    try {
        parsed = JSON.parse(workflowJson);
    } catch (e) {
        console.warn(`[${extensionName}] workflow JSON invalid, skip upscale injection:`, e?.message || e);
        return workflowJson;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return workflowJson;

    // 已有接好线的放大链 → 只改 loader 的 model_name
    const wiredLoaderIds = new Set();
    for (const node of Object.values(parsed)) {
        const ref = node?.inputs?.upscale_model;
        if (node?.class_type === 'ImageUpscaleWithModel' && Array.isArray(ref) && parsed[String(ref[0])]?.class_type === 'UpscaleModelLoader') {
            wiredLoaderIds.add(String(ref[0]));
        }
    }
    if (wiredLoaderIds.size) {
        for (const id of wiredLoaderIds) parsed[id].inputs.model_name = modelName;
        return JSON.stringify(parsed);
    }

    // 终端节点 = 自身 id 未被任何节点引用,且 images 输入是有效节点引用
    const referenced = new Set();
    for (const node of Object.values(parsed)) {
        const inputs = node?.inputs;
        if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) continue;
        for (const val of Object.values(inputs)) {
            if (Array.isArray(val) && val.length === 2 && typeof val[1] === 'number') referenced.add(String(val[0]));
        }
    }
    const terminals = [];
    for (const [id, node] of Object.entries(parsed)) {
        const img = node?.inputs?.images;
        if (!referenced.has(id) && Array.isArray(img) && parsed[String(img[0])]) {
            terminals.push({ id, source: [String(img[0]), img[1]] });
        }
    }
    if (!terminals.length) {
        console.warn(`[${extensionName}] no terminal image output node found, skip upscale injection`);
        return workflowJson;
    }

    // 新节点 id:数值 key 最大值起递增(与 addLoraToWorkflow 同法,避免撞已有 key)
    const loaderId = String(Object.keys(parsed).reduce((m, k) => Math.max(m, Number.parseInt(k, 10) || 0), 0) + 1);
    parsed[loaderId] = { inputs: { model_name: modelName }, class_type: 'UpscaleModelLoader' };

    let nextId = Number(loaderId) + 1;
    const upscaleIdBySource = new Map();
    for (const t of terminals) {
        const key = t.source.join('\u0000');
        if (!upscaleIdBySource.has(key)) {
            const upId = String(nextId++);
            parsed[upId] = { inputs: { upscale_model: [loaderId, 0], image: t.source }, class_type: 'ImageUpscaleWithModel' };
            upscaleIdBySource.set(key, upId);
        }
        parsed[t.id].inputs.images = [upscaleIdBySource.get(key), 0];
    }
    return JSON.stringify(parsed);
}

/**
 * 直接调远程 ComfyUI 生成媒体。返回 { url, format, character }。
 * url 是 ST 后端落盘后的文件路径(/user/images/...),避免 data URI 撑爆 DOM 和聊天存档。
 * @param {string} overrideCharacter 可选,覆盖 character(默认走 context.name2 / groupId / 'media')。测试 tab 传 preset.name。
 *
 * 外壳:入串行队列,真正执行交给 generateViaComfyInner。
 * 这样改 URL/工作流/前缀等配置后点重试,等到 job 真跑时会重新读 active preset,新配置立即生效。
 */
async function generateViaComfy(modifiedPrompt, mediaType, overrideCharacter, forceRandomSeed = false, signal = null) {
    return enqueueComfyJob(() => generateViaComfyInner(modifiedPrompt, mediaType, overrideCharacter, forceRandomSeed, signal));
}

/** 全局激活的 ComfyUI 服务地址(跨 preset 共享) */
function getActiveComfyUrl() {
    return String(extension_settings[extensionName].activeComfyUrl || '').trim();
}

async function generateViaComfyInner(modifiedPrompt, mediaType, overrideCharacter, forceRandomSeed = false, signal = null) {
    const preset = getActivePreset();
    if (!preset) throw new Error('No active ComfyUI preset configured');
    const comfyUrl = getActiveComfyUrl();
    if (!comfyUrl) throw new Error('No ComfyUI URL configured');
    if (!preset.model) throw new Error('Active preset has no model selected');

    // 前缀末尾无逗号 → 自动补一个,避免 "1girl" + "solo" 粘连成 "1girlsolo"
    const prefix = (preset.positivePromptPrefix || '').trimEnd();
    const sep = prefix && !prefix.endsWith(',') ? ',' : '';
    const finalPrompt = prefix + sep + modifiedPrompt;
    const negativePrompt = preset.negativePromptPrefix || '';
    let workflow = applyWorkflowPlaceholders(preset.workflowJson, preset, finalPrompt, negativePrompt, forceRandomSeed);
    if (preset.upscaleModel) workflow = injectUpscaleIntoWorkflowJson(workflow, preset.upscaleModel);

    const body = { url: comfyUrl, prompt: `{ "prompt": ${workflow} }` };
    if (preset.comfyAuth) body.auth = preset.comfyAuth;

    // 视频生成耗时可达数分钟(大模型+多帧采样),超时 5min;图片 30s
    const timeoutMs = mediaType === 'video' ? 300_000 : 30_000;
    const result = await comfyProxy('generate', body, timeoutMs, signal);
    const format = (result.format || (mediaType === 'video' ? 'mp4' : 'png')).toLowerCase();

    const context = getContext();
    const charName = (overrideCharacter || context.name2 || context.groupId || 'media').replace(/[\\\/]/g, '_');
    const filename = `${mediaType}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const url = await saveBase64AsFile(result.data, charName, filename, format);

    return { url, format, character: charName, finalPrompt };
}

// --- 设置与UI逻辑 ---

// --- 配置档(Preset)UI 渲染 ---

// 内存缓存当前地址的 model/sampler/scheduler/lora/upscale 列表(url 字段=缓存所属地址,失配即过期)。
// 持久化版本在 extension_settings[extensionName].comfyListCache(按地址分档),点『连接』成功时写入,
// 刷新页面/切配置档后由 hydrateComfyCacheFromSettings 灌回,免重新连接。
const comfyCache = { models: [], samplers: [], schedulers: [], loras: [], upscaleModels: [], url: '' };
function resetComfyCache() {
    comfyCache.models = [];
    comfyCache.samplers = [];
    comfyCache.schedulers = [];
    comfyCache.loras = [];
    comfyCache.upscaleModels = [];
    comfyCache.url = '';
}

/** comfyListCache 持久化 key:URL 去尾部斜杠(避免带/不带斜杠的同一地址写成两档) */
function comfyListCacheKey(url) {
    return String(url || '').trim().replace(/\/+$/, '');
}

/**
 * 把本轮成功拉到的列表组持久化(按 ComfyUI 地址分档)。
 * fresh 只含成功拉到的组——部分失败不清掉旧存档,下次点『连接』成功才覆盖为最新。
 */
function persistComfyListCache(comfyUrl, fresh) {
    const s = extension_settings[extensionName];
    if (!s.comfyListCache || typeof s.comfyListCache !== 'object' || Array.isArray(s.comfyListCache)) s.comfyListCache = {};
    const key = comfyListCacheKey(comfyUrl);
    s.comfyListCache[key] = { ...(s.comfyListCache[key] || {}), ...fresh, savedAt: Date.now() };
    saveSettingsDebounced();
}

/** 从持久化存档灌回 comfyCache(当前地址有存档时);没有则清空等待首次『连接』 */
function hydrateComfyCacheFromSettings() {
    const entry = extension_settings[extensionName]?.comfyListCache?.[comfyListCacheKey(getActiveComfyUrl())];
    if (entry && typeof entry === 'object') {
        comfyCache.models = Array.isArray(entry.models) ? entry.models : [];
        comfyCache.samplers = Array.isArray(entry.samplers) ? entry.samplers : [];
        comfyCache.schedulers = Array.isArray(entry.schedulers) ? entry.schedulers : [];
        comfyCache.loras = Array.isArray(entry.loras) ? entry.loras : [];
        comfyCache.upscaleModels = Array.isArray(entry.upscaleModels) ? entry.upscaleModels : [];
        comfyCache.url = getActiveComfyUrl();
    } else {
        resetComfyCache();
    }
}

/** 重建配置档 dropdown options,选中 active */
function renderPresetDropdown() {
    const $select = $('#comfy_preset_select');
    if (!$select.length) return;

    const presets = extension_settings[extensionName].comfyPresets || [];
    const activeName = extension_settings[extensionName].activePresetName;

    // 灌值前临时解绑 change 事件,避免触发连锁
    $select.off('change.preset');
    $select.empty();
    if (presets.length === 0) {
        $select.append('<option value="" disabled selected data-i18n="No preset">No preset</option>');
    } else {
        for (const p of presets) {
            $select.append(`<option value="${escapeHtmlAttribute(p.name)}"${p.name === activeName ? ' selected' : ''}>${escapeHtmlAttribute(p.name)}</option>`);
        }
    }
    $select.val(activeName || '');
    $select.on('change.preset', onPresetSelectChange);
    renderPresetGallery();
}

/** 渲染 ComfyUI preset 缩略图网格(快速点击切换) */
function renderPresetGallery() {
    const $grid = $('#comfy_preset_gallery');
    if (!$grid.length) return;
    const presets = extension_settings[extensionName].comfyPresets || [];
    const activeName = extension_settings[extensionName].activePresetName;
    const $wrap = $grid.closest('#comfy_preset_gallery_wrap');
    $grid.empty();
    if (presets.length === 0) {
        $wrap.css('display', 'none');
        return;
    }
    $wrap.css('display', '');
    for (const p of presets) {
        const isActive = p.name === activeName;
        const inner = p.previewImage
            ? `<img src="${escapeHtmlAttribute(p.previewImage)}" alt="">`
            : `<div class="mag-preset-thumb-empty"><i class="fa-solid fa-image"></i></div>`;
        const $thumb = $(`
            <div class="mag-preset-thumb${isActive ? ' active' : ''}" data-name="${escapeHtmlAttribute(p.name)}">
                ${inner}
                <div class="mag-preset-thumb-name">${escapeHtmlAttribute(p.name)}</div>
                <div class="mag-preset-thumb-badge"><i class="fa-solid fa-check"></i></div>
            </div>
        `);
        $grid.append($thumb);
    }
}

/** 从 URL 派生可读名(主机+路径),失败 fallback 完整 URL */
function deriveUrlName(url) {
    if (!url) return '';
    try {
        const u = new URL(url);
        return u.host + (u.pathname && u.pathname !== '/' ? u.pathname : '');
    } catch {
        return url;
    }
}

/** 渲染 ComfyUI URL 地址簿下拉;当前 input 中的 URL 命中时高亮选中 */
function renderComfyUrlBookmark() {
    const $sel = $('#comfy_url_bookmark');
    if (!$sel.length) return;
    const urls = extension_settings[extensionName].comfyUrls || [];
    const currentUrl = ($('#comfy_url').val() || '').trim();

    $sel.empty();
    if (urls.length === 0) {
        $sel.append('<option value="" data-i18n="mag_url_bookmark_empty">-- 暂无已保存地址 --</option>');
    } else {
        const $ph = $('<option value=""></option>').text('— 选择已保存地址 —');
        $sel.append($ph);
        for (const item of urls) {
            const v = typeof item === 'string' ? item : item.url;
            const n = (typeof item === 'object' && item.name) ? item.name : deriveUrlName(v);
            const $opt = $('<option></option>').val(v).text(n);
            $sel.append($opt);
        }
    }
    $sel.val(urls.some(u => (typeof u === 'string' ? u : u.url) === currentUrl) ? currentUrl : '');
}

/** 地址簿事件:select 切换 = 写回 input(联动全局 activeComfyUrl);保存 = 把当前 input URL 入簿;删除 = 移除 select 当前选中 */
function bindComfyUrlBookmarkEvents() {
    $('#comfy_url_bookmark').off('.urlBookmark').on('change.urlBookmark', function () {
        const v = String($(this).val() || '').trim();
        if (!v) return;
        // 写回 input 并触发 change → 已有的 .preset handler 会写回全局 activeComfyUrl + 清缓存
        $('#comfy_url').val(v).trigger('change');
    });
    $('#comfy_url_save').off('.urlBookmark').on('click.urlBookmark', function () {
        const v = ($('#comfy_url').val() || '').trim();
        if (!v) { toastr.warning('ComfyUI 服务地址为空'); return; }
        const urls = extension_settings[extensionName].comfyUrls || (extension_settings[extensionName].comfyUrls = []);
        if (urls.some(u => (typeof u === 'string' ? u : u.url) === v)) {
            toastr.info('该地址已在地址簿中');
            renderComfyUrlBookmark();
            return;
        }
        urls.push({ name: deriveUrlName(v), url: v });
        saveSettingsDebounced();
        renderComfyUrlBookmark();
    });
    $('#comfy_url_delete').off('.urlBookmark').on('click.urlBookmark', function () {
        const v = String($('#comfy_url_bookmark').val() || '').trim();
        if (!v) { toastr.warning('请先在地址簿下拉里选择要删除的项'); return; }
        const urls = extension_settings[extensionName].comfyUrls || [];
        const idx = urls.findIndex(u => (typeof u === 'string' ? u : u.url) === v);
        if (idx < 0) return;
        const name = (typeof urls[idx] === 'object' ? urls[idx].name : null) || deriveUrlName(v);
        if (!window.confirm(`从地址簿删除 "${name}"?`)) return;
        urls.splice(idx, 1);
        saveSettingsDebounced();
        renderComfyUrlBookmark();
    });
}

/** 渲染 detail 接口 URL 历史下拉;空时显示占位 */
function renderComfyImportUrlBookmark() {
    const $sel = $('#comfy_import_url_bookmark');
    if (!$sel.length) return;
    const urls = extension_settings[extensionName].comfyImportUrls || [];
    const currentUrl = ($('#comfy_import_url').val() || '').trim();

    $sel.empty();
    if (urls.length === 0) {
        $sel.append('<option value="" data-i18n="mag_import_url_bookmark_empty">-- 暂无历史 --</option>');
    } else {
        $sel.append('<option value="">— 选择历史 URL —</option>');
        for (const v of urls) {
            const $opt = $('<option></option>').val(v).text(v);
            $sel.append($opt);
        }
    }
    $sel.val(urls.includes(currentUrl) && currentUrl ? currentUrl : '');
}

/** 历史下拉事件:select 切换 = 灌回 input(不自动拉取,让用户决定);删除按钮 = 移除当前选中 */
function bindComfyImportUrlBookmarkEvents() {
    $('#comfy_import_url_bookmark').off('.importBookmark').on('change.importBookmark', function () {
        const v = String($(this).val() || '').trim();
        if (!v) return;
        $('#comfy_import_url').val(v);
    });
    $('#comfy_import_url_delete').off('.importBookmark').on('click.importBookmark', function () {
        const v = String($('#comfy_import_url_bookmark').val() || '').trim();
        if (!v) { toastr.warning('请先在历史下拉里选择要删除的项'); return; }
        const urls = extension_settings[extensionName].comfyImportUrls || [];
        const idx = urls.indexOf(v);
        if (idx < 0) return;
        if (!window.confirm(`从历史删除此 URL?`)) return;
        urls.splice(idx, 1);
        saveSettingsDebounced();
        renderComfyImportUrlBookmark();
    });
}

/** 把 detail URL 加入历史(去重,新值置顶) */
function pushComfyImportUrl(url) {
    const v = String(url || '').trim();
    if (!v) return;
    const urls = extension_settings[extensionName].comfyImportUrls || (extension_settings[extensionName].comfyImportUrls = []);
    const idx = urls.indexOf(v);
    if (idx === 0) return;          // 已是第一个,无需动
    if (idx > 0) urls.splice(idx, 1); // 已存在但非首位,提到首位
    urls.unshift(v);
    saveSettingsDebounced();
}

/** 把 active preset 字段灌进各 input/select/textarea;active 为 null 时显示空状态 */
function renderPresetFields() {
    // 内存缓存与当前地址失配(刷新页面/首次打开/换了地址)→ 从持久化存档灌回,免重新点『连接』
    if (comfyCache.url !== getActiveComfyUrl()) hydrateComfyCacheFromSettings();
    const preset = getActivePreset();
    const hasPreset = !!preset;
    $('#comfy_empty_hint').css('display', hasPreset ? 'none' : 'block');

    // 临时解绑所有字段事件,灌值后再绑回(避免连锁写)
    $('#comfy_url, #comfy_model, #comfy_sampler, #comfy_scheduler, #comfy_upscale, #comfy_width, #comfy_height, #comfy_steps, #comfy_scale, #comfy_denoise, #comfy_seed, #comfy_pos_prefix, #comfy_neg_prefix, #comfy_workflow').off('.preset');

    $('#comfy_url').val(getActiveComfyUrl());
    $('#comfy_pos_prefix').val(preset?.positivePromptPrefix || '');
    $('#comfy_neg_prefix').val(preset?.negativePromptPrefix || '');
    $('#comfy_workflow').val(preset?.workflowJson || '');
    validateComfyWorkflow();
    $('#comfy_width').val(preset?.width ?? 640);
    $('#comfy_height').val(preset?.height ?? 960);
    $('#comfy_steps').val(preset?.steps ?? 20);
    $('#comfy_scale').val(preset?.scale ?? 7);
    $('#comfy_denoise').val(preset?.denoise ?? 1);
    $('#comfy_seed').val(preset?.seed ?? -1);

    // model/sampler/scheduler:渲染已缓存列表 + 当前选中值
    renderComfySelect('#comfy_model', comfyCache.models, preset?.model || '');
    renderComfySelect('#comfy_sampler', comfyCache.samplers, preset?.sampler || '');
    renderComfySelect('#comfy_scheduler', comfyCache.schedulers, preset?.scheduler || '');

    // 放大模型:首项恒为『不使用』,列表来自 comfyCache.upscaleModels
    renderUpscaleSelect(preset?.upscaleModel || '');

    // 字段使能状态(无 preset 时 disabled;comfy_url 系全局字段不依赖 preset)
    $('#comfy_model, #comfy_sampler, #comfy_scheduler, #comfy_upscale, #comfy_width, #comfy_height, #comfy_steps, #comfy_scale, #comfy_denoise, #comfy_seed, #comfy_pos_prefix, #comfy_neg_prefix, #comfy_workflow, #comfy_refresh').prop('disabled', !hasPreset);

    bindPresetFieldEvents();
    renderPresetPreview();
    renderComfyUrlBookmark();
    renderComfyImportUrlBookmark();
}

/** 渲染单个 ComfyUI select(model/sampler/scheduler) */
function renderComfySelect(selector, options, currentValue) {
    const $sel = $(selector);
    $sel.empty();
    if (options.length === 0) {
        $sel.append(`<option value="" data-i18n="Refresh first">-- refresh first --</option>`);
        // 若 currentValue 非空,仍保留它作为隐藏选项便于切换 preset 后看到值
        if (currentValue) {
            $sel.append(`<option value="${escapeHtmlAttribute(currentValue)}" selected>${escapeHtmlAttribute(currentValue)}</option>`);
        }
        $sel.val(currentValue);
        return;
    }
    for (const opt of options) {
        // options 可能是 ['dpmpp_2m', ...] 或 [{value, text}, ...]
        const value = typeof opt === 'string' ? opt : opt.value;
        const text = typeof opt === 'string' ? opt : (opt.text || opt.value);
        $sel.append(`<option value="${escapeHtmlAttribute(String(value))}">${escapeHtmlAttribute(String(text))}</option>`);
    }
    $sel.val(currentValue);
}

/** 渲染放大模型 select:首项恒为『不使用』(空值=不注入),选项来自 comfyCache.upscaleModels;无列表时保留已存值便于回显 */
function renderUpscaleSelect(currentValue) {
    const $sel = $('#comfy_upscale');
    if (!$sel.length) return;
    $sel.empty();
    $sel.append(`<option value="" data-i18n="mag_upscale_none">不使用</option>`);
    const opts = (comfyCache.upscaleModels || []).map(o => typeof o === 'string' ? o : String(o?.value ?? o));
    // 已存值不在列表里(列表还没拉/后端没补丁)→ 追加为独立选项,保证回显不丢
    if (currentValue && !opts.includes(currentValue)) opts.push(currentValue);
    for (const v of opts) {
        $sel.append(`<option value="${escapeHtmlAttribute(v)}">${escapeHtmlAttribute(v)}</option>`);
    }
    $sel.val(currentValue || '');
}

function onPresetSelectChange() {
    const newName = $(this).val();
    extension_settings[extensionName].activePresetName = newName || null;
    saveSettingsDebounced();
    // 不清列表缓存:地址是全局的,切档后 renderPresetFields 按地址守卫自动处理失配
    renderPresetFields();
}

function bindPresetFieldEvents() {
    // 写入工具:把当前 DOM 值写回 active preset
    const writeField = (key, value) => {
        const preset = getActivePreset();
        if (!preset) return;
        preset[key] = value;
        saveSettingsDebounced();
    };

    // 数值字段:input 事件,parseFloat + NaN→0(保留空串便于用户清空编辑,但保存时转 0)
    const writeNumber = (key, parser = parseFloat) => (e) => {
        const raw = $(e.target).val();
        const v = raw === '' ? 0 : parser(raw);
        writeField(key, Number.isFinite(v) ? v : 0);
    };

    $('#comfy_url').on('change.preset', (e) => {
        extension_settings[extensionName].activeComfyUrl = $(e.target).val().trim();
        saveSettingsDebounced();
        // URL 改变 → renderPresetFields 按新地址从持久化存档灌列表(有存档直接用,没有则显示 refresh first)
        renderPresetFields();
    });
    $('#comfy_pos_prefix').on('change.preset', (e) => writeField('positivePromptPrefix', $(e.target).val()));
    $('#comfy_neg_prefix').on('change.preset', (e) => writeField('negativePromptPrefix', $(e.target).val()));
    $('#comfy_workflow').on('change.preset', (e) => writeField('workflowJson', $(e.target).val()));

    $('#comfy_model').on('change.preset', (e) => writeField('model', $(e.target).val()));
    $('#comfy_sampler').on('change.preset', (e) => writeField('sampler', $(e.target).val()));
    $('#comfy_scheduler').on('change.preset', (e) => writeField('scheduler', $(e.target).val()));
    $('#comfy_upscale').on('change.preset', (e) => writeField('upscaleModel', $(e.target).val()));

    $('#comfy_width').on('input.preset', writeNumber('width', parseInt));
    $('#comfy_height').on('input.preset', writeNumber('height', parseInt));
    $('#comfy_steps').on('input.preset', writeNumber('steps', parseInt));
    $('#comfy_scale').on('input.preset', writeNumber('scale'));
    $('#comfy_denoise').on('input.preset', writeNumber('denoise'));
    $('#comfy_seed').on('input.preset', writeNumber('seed', parseInt));
}

/** 新建 preset(自动唯一名) */
function createPreset() {
    const presets = extension_settings[extensionName].comfyPresets;
    const name = getUniqueName('New Preset', n => presets.some(p => p.name === n), {
        nameBuilder: (base, i) => i === 1 ? base : `${base} ${i}`,
    });
    presets.push({
        name,
        comfyAuth: '',
        workflowJson: '',
        model: '', sampler: '', scheduler: '', upscaleModel: '',
        width: 640, height: 960, steps: 20, scale: 7, denoise: 1, seed: -1,
        positivePromptPrefix: '',
        negativePromptPrefix: '',
    });
    extension_settings[extensionName].activePresetName = name;
    saveSettingsDebounced();
    renderPresetDropdown();
    renderPresetFields();
}

/** 复制当前 preset */
function duplicatePreset() {
    const src = getActivePreset();
    if (!src) { toastr.warning('No active preset to duplicate'); return; }
    const presets = extension_settings[extensionName].comfyPresets;
    const name = getUniqueName(`${src.name} copy`, n => presets.some(p => p.name === n), {
        nameBuilder: (base, i) => i === 1 ? base : `${base} ${i}`,
    });
    presets.push({ ...src, name, previewImage: '' });
    extension_settings[extensionName].activePresetName = name;
    saveSettingsDebounced();
    renderPresetDropdown();
    renderPresetFields();
}

/** 改名当前 preset(prompt 输入 + 唯一性校验) */
function renamePreset() {
    const src = getActivePreset();
    if (!src) return;
    const newName = window.prompt('Rename preset to:', src.name);
    if (newName === null) return;
    const trimmed = newName.trim();
    if (!trimmed) { toastr.warning('Name cannot be empty'); return; }
    if (trimmed === src.name) return;
    const presets = extension_settings[extensionName].comfyPresets;
    if (presets.some(p => p.name === trimmed)) {
        toastr.warning(`Preset "${trimmed}" already exists`);
        return;
    }
    src.name = trimmed;
    extension_settings[extensionName].activePresetName = trimmed;
    saveSettingsDebounced();
    renderPresetDropdown();
    renderPresetFields();
}

/** 删除当前 preset(confirm + active 回落) */
function deletePreset() {
    const src = getActivePreset();
    if (!src) return;
    if (!window.confirm(`Delete preset "${src.name}"?`)) return;
    const oldPreview = src.previewImage || '';
    const presets = extension_settings[extensionName].comfyPresets;
    const idx = presets.findIndex(p => p.name === src.name);
    if (idx >= 0) presets.splice(idx, 1);
    extension_settings[extensionName].activePresetName = presets[0]?.name ?? null;
    saveSettingsDebounced();
    renderPresetDropdown();
    renderPresetFields();
    if (oldPreview) deletePreviewFile(oldPreview);
}

/** 并发拉取 model/sampler/scheduler 列表,单个失败不阻断。每次点击都重新发起。 */
async function refreshComfyOptions() {
    const preset = getActivePreset();
    const comfyUrl = getActiveComfyUrl();
    if (!preset || !comfyUrl) {
        toastr.warning('请先填 ComfyUI 服务地址');
        return;
    }
    toastr.info('正在连接 ComfyUI...');
    const body = { url: comfyUrl };
    if (preset.comfyAuth) body.auth = preset.comfyAuth;
    const results = await Promise.allSettled([
        comfyProxy('models', body, 10_000),
        comfyProxy('samplers', body, 10_000),
        comfyProxy('schedulers', body, 10_000),
    ]);
    console.log('[mag-debug] allSettled done', results.map(r => ({ status: r.status, reason: r.reason ? String(r.reason.message || r.reason).slice(0, 100) : null })));
    const [modelsR, samplersR, schedulersR] = results;
    const okCount = results.filter(r => r.status === 'fulfilled').length;
    console.log('[mag-debug] okCount', okCount, 'results.length=', results.length, 'cond=', okCount === results.length);
    if (okCount === results.length) {
        comfyCache.models = modelsR.value;
        comfyCache.samplers = samplersR.value;
        comfyCache.schedulers = schedulersR.value;
        comfyCache.url = comfyUrl;
        toastr.success(`ComfyUI 连接成功(${modelsR.value.length} 模型 / ${samplersR.value.length} 采样器 / ${schedulersR.value.length} 调度器)`);
    } else {
        // 部分或全部失败:重置缓存,避免渲染下拉时混入旧 url 的数据
        console.log('[mag-debug] entering else, okCount=', okCount);
        resetComfyCache();
        console.log('[mag-debug] after resetComfyCache, okCount=', okCount, 'reason models=', modelsR.reason, 'msg=', modelsR.reason?.message);
        if (okCount === 0) {
            console.log('[mag-debug] about to call toastr.error');
            toastr.error(`ComfyUI 连接失败:${modelsR.reason?.message || modelsR.reason}`);
            console.log('[mag-debug] toastr.error called');
        } else {
            const failed = [
                modelsR.status !== 'fulfilled' && `模型(${modelsR.reason?.message || modelsR.reason})`,
                samplersR.status !== 'fulfilled' && `采样器(${samplersR.reason?.message || samplersR.reason})`,
                schedulersR.status !== 'fulfilled' && `调度器(${schedulersR.reason?.message || schedulersR.reason})`,
            ].filter(Boolean).join('、');
            toastr.warning(`部分失败(${okCount}/${results.length}):${failed}`);
        }
    }
    // LoRA 列表:浏览器直连 ComfyUI(--enable-cors-header);失败降级为手动输入文件名,null=本轮未拉到
    const lorasR = await fetchLorasDirect(comfyUrl).catch(err => {
        console.debug('[media-auto-generation] loras list unavailable (需 ComfyUI 带 --enable-cors-header 启动):', err?.message || err);
        return null;
    });
    comfyCache.loras = lorasR || [];
    // 放大模型列表:浏览器直连 ComfyUI(--enable-cors-header);失败降级为下拉仅显示已存值
    const upscaleR = await fetchUpscaleModelsDirect(comfyUrl).catch(err => {
        console.debug('[media-auto-generation] upscale model list unavailable (需 ComfyUI 带 --enable-cors-header 启动):', err?.message || err);
        return null;
    });
    comfyCache.upscaleModels = upscaleR || [];
    // 部分失败也标记地址:renderPresetFields 的失配守卫才不会拿旧存档覆盖本轮已拉到的结果
    comfyCache.url = comfyUrl;

    // 持久化到 comfyListCache(按地址分档):只写本轮成功拉到的组,部分失败保留旧存档;下次免重新连接
    const fresh = {};
    if (okCount === results.length) {
        fresh.models = comfyCache.models;
        fresh.samplers = comfyCache.samplers;
        fresh.schedulers = comfyCache.schedulers;
    }
    if (lorasR) fresh.loras = comfyCache.loras;
    if (upscaleR) fresh.upscaleModels = comfyCache.upscaleModels;
    if (Object.keys(fresh).length) persistComfyListCache(comfyUrl, fresh);
    renderPresetFields();
}

/** 从 detail URL 拉取并应用到当前 preset(workflow/prefix/negative/preview 4 项) */
async function fetchAndApplyImportUrl() {
    const preset = getActivePreset();
    if (!preset) { toastr.warning('请先选择一个配置档'); return; }
    const rawUrl = ($('#comfy_import_url').val() || '').trim();
    if (!rawUrl) { toastr.warning('请输入 detail 接口 URL'); return; }
    try { new URL(rawUrl); } catch { toastr.error('URL 格式无效'); return; }

    const $btn = $('#comfy_import_btn');
    $btn.css('opacity', '0.5').css('pointer-events', 'none');
    toastr.info('拉取中...');

    try {
        const res = await fetch(rawUrl, { headers: { 'Accept': 'application/json' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        const missing = ['workflow', 'prefix', 'negative', 'cover'].filter(k => !data[k]);
        if (missing.length) throw new Error(`接口缺少字段: ${missing.join(', ')}`);

        const coverMatch = String(data.cover).match(/^data:image\/([a-zA-Z0-9]+);base64,(.+)$/);
        if (!coverMatch) throw new Error('cover 格式无效(应为 data:image/...;base64,...)');
        const ext = coverMatch[1].toLowerCase().replace(/[^a-z0-9]/g, '') || 'png';
        const base64 = coverMatch[2];

        const summary = [
            `name: ${data.name || '(无)'}`,
            `model: ${data.checkpoint || '(接口未返回,保持当前值)'}`,
            `workflow: ${data.workflow.length} 字符`,
            `正向 prefix: ${data.prefix.length} 字符`,
            `负面 prefix: ${data.negative.length} 字符`,
            `cover: ${ext} (${(base64.length * 0.75 / 1024).toFixed(0)} KB)`,
        ].join('\n');
        if (!window.confirm(`确认导入到当前配置档 "${preset.name}"?\n\n${summary}`)) return;

        const newPath = await uploadPreviewBase64(base64, ext);

        // 应用字段 + 删旧预览图(checkpoint 可选,接口没返回则不动 preset.model)
        const oldPath = preset.previewImage || '';
        preset.workflowJson = data.workflow;
        preset.positivePromptPrefix = data.prefix;
        preset.negativePromptPrefix = data.negative;
        preset.previewImage = newPath;
        if (data.checkpoint) preset.model = data.checkpoint;
        saveSettingsDebounced();
        if (oldPath && oldPath !== newPath) await deletePreviewFile(oldPath);

        renderPresetFields();  // 内部会触发 validateComfyWorkflow + renderPresetPreview
        toastr.success('已应用导入的配置');
        pushComfyImportUrl(rawUrl);   // 应用成功后把 URL 入历史(去重 + 置顶)
        $('#comfy_import_url').val('');
        renderComfyImportUrlBookmark();
    } catch (e) {
        console.error(`[${extensionName}] Import failed:`, e);
        toastr.error(e.message || String(e));
    } finally {
        $btn.css('opacity', '').css('pointer-events', '');
    }
}

// --- 预览图上传/删除 ---

const PREVIEW_MAX_BYTES = 8 * 1024 * 1024; // 8MB
const PREVIEW_FILENAME_PREFIX = 'mag-preset_preview_';

/** 把 base64 上传到 ST user/files,返回相对路径(可直接当 <img src>) */
async function uploadPreviewBase64(base64, ext) {
    const filename = `${PREVIEW_FILENAME_PREFIX}${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const res = await fetch('/api/files/upload', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ name: filename, data: base64 }),
    });
    if (!res.ok) throw new Error(`上传失败: ${await res.text()}`);
    return (await res.json()).path;
}

/** 把 File 上传为当前 preset 的预览图(校验 + 走 uploadPreviewBase64) */
async function uploadPreviewFile(file) {
    if (!file) return null;
    if (!file.type.startsWith('image/')) {
        toastr.warning('Please select an image file');
        return null;
    }
    if (file.size > PREVIEW_MAX_BYTES) {
        toastr.warning('Image too large (max 8MB)');
        return null;
    }
    const dataUrl = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = () => reject(new Error('FileReader failed'));
        r.readAsDataURL(file);
    });
    const base64 = dataUrl.split(',')[1];
    const ext = (file.name.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '') || 'png';
    return await uploadPreviewBase64(base64, ext);
}

/** 删除指定 path 的预览图文件,失败仅 console.warn(不阻断主流程) */
async function deletePreviewFile(path) {
    if (!path) return;
    try {
        const res = await fetch('/api/files/delete', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ path }),
        });
        if (!res.ok) {
            console.warn(`[${extensionName}] Failed to delete preview file ${path}: ${await res.text()}`);
        }
    } catch (e) {
        console.warn(`[${extensionName}] Failed to delete preview file ${path}:`, e);
    }
}

/** 上传新文件作为当前 preset 的预览图(替换旧图) */
async function uploadPresetPreviewFile(file) {
    const preset = getActivePreset();
    if (!preset) return;
    toastr.info('Uploading preview...');
    try {
        const newPath = await uploadPreviewFile(file);
        if (!newPath) return;
        const oldPath = preset.previewImage || '';
        preset.previewImage = newPath;
        saveSettingsDebounced();
        if (oldPath && oldPath !== newPath) {
            await deletePreviewFile(oldPath);
        }
        renderPresetPreview();
        toastr.success('Preview uploaded');
    } catch (e) {
        console.error(`[${extensionName}] Preview upload failed:`, e);
        toastr.error(e.message || String(e));
    }
}

/** 渲染当前 preset 的预览图区域(空状态/有图) */
function renderPresetPreview() {
    const preset = getActivePreset();
    const hasPreset = !!preset;
    const hasImg = !!(preset && preset.previewImage);

    const $wrap = $('#comfy_preview_wrap');
    if (!$wrap.length) return;

    const $empty = $('#comfy_preview_empty');
    const $img = $('#comfy_preview_img');
    const $actions = $('#comfy_preview_actions');

    $wrap.css('display', hasPreset ? 'block' : 'none');
    if (!hasPreset) return;

    if (hasImg) {
        // 加 ?ts= 避免同路径刷新缓存(同一文件被覆盖时)
        $img.attr('src', preset.previewImage).css('display', 'block');
        $empty.css('display', 'none');
        $actions.css('display', 'flex');
    } else {
        $img.attr('src', '').css('display', 'none');
        $empty.css('display', 'flex');
        $actions.css('display', 'none');
    }
    renderPresetGallery();
}

function bindPresetPreviewEvents() {
    $('#comfy_preview_input').off('.preview').on('change.preview', function (e) {
        const f = e.target.files?.[0];
        e.target.value = ''; // 清空,允许下次还能选同一文件
        if (f) uploadPresetPreviewFile(f);
    });
    $('#comfy_preview_empty').off('.preview').on('click.preview', function () {
        if (!getActivePreset()) return;
        $('#comfy_preview_input').trigger('click');
    });
    $('#comfy_preview_img').off('.preview').on('click.preview', function () {
        $('#comfy_preview_input').trigger('click');
    });
    $('#comfy_preview_change').off('.preview').on('click.preview', function (e) {
        e.stopPropagation();
        $('#comfy_preview_input').trigger('click');
    });
    $('#comfy_preview_delete').off('.preview').on('click.preview', async function (e) {
        e.stopPropagation();
        const preset = getActivePreset();
        if (!preset || !preset.previewImage) return;
        if (!window.confirm('Delete preview image?')) return;
        const oldPath = preset.previewImage;
        preset.previewImage = '';
        saveSettingsDebounced();
        renderPresetPreview();
        await deletePreviewFile(oldPath);
    });
}

function getWorkflowPlaceholderUsage(text) {
    const used = new Set();
    const all = new Set();
    const matches = text.match(/%[a-zA-Z_][a-zA-Z0-9_]*%/g) || [];
    for (const m of matches) {
        const k = m.slice(1, -1);
        all.add(k);
        if (SUPPORTED_PLACEHOLDERS.includes(k)) used.add(k);
    }
    const invalid = [...all].filter(k => !SUPPORTED_PLACEHOLDERS.includes(k));
    return { used, invalid };
}

function validateComfyWorkflow() {
    const val = $('#comfy_workflow').val() || '';
    let jsonError = null;
    let parsed = null;
    const trimmed = val.trim();
    if (trimmed) {
        try { parsed = JSON.parse(trimmed); }
        catch (e) { jsonError = e.message; }
    }
    $('#comfy_workflow').toggleClass('mag_workflow_invalid', !!jsonError);
    const $err = $('#comfy_workflow_error');
    if (jsonError) {
        $err.text('JSON: ' + jsonError).css('display', 'block');
    } else {
        $err.empty().css('display', 'none');
    }
    const $pop = $('#comfy_workflow_popover');
    if ($pop.is(':visible')) renderWorkflowPopover(val);

    renderLoraEditor(parsed); // 工作流 JSON 变更后同步 LoRA 强度列表(复用本次已解析结果)
}

function renderWorkflowPopover(val) {
    const { used, invalid } = getWorkflowPlaceholderUsage(val || '');
    const phRow = (icon, color, k) =>
        `<div class="mag_ph_item"><i class="fa-solid ${icon}" style="color:${color}; width:14px; text-align:center;"></i><code>%${k}%</code></div>`;
    const rows = SUPPORTED_PLACEHOLDERS.map(k => {
        const ok = used.has(k);
        return phRow(ok ? 'fa-check' : 'fa-xmark', ok ? '#5d9e5d' : 'var(--fullred, #f44336)', k);
    });
    const invalidHtml = invalid.length
        ? `<hr class="mag_ph_divider">${invalid.map(k => phRow('fa-triangle-exclamation', 'var(--fullred, #f44336)', k)).join('')}`
        : '';
    $('#comfy_workflow_popover').html(rows.join('') + invalidHtml);
}

function toggleWorkflowPopover() {
    const $pop = $('#comfy_workflow_popover');
    if ($pop.is(':visible')) {
        $pop.css('display', 'none');
    } else {
        renderWorkflowPopover($('#comfy_workflow').val() || '');
        $pop.css('display', 'block');
    }
}

function toggleAutoReplacePopover() {
    const $pop = $('#auto_replace_popover');
    if ($pop.is(':visible')) {
        $pop.css('display', 'none');
    } else {
        $pop.css('display', 'block');
    }
}

// --- LoRA 强度编辑:从工作流 JSON 提取 LoRA 节点,编辑 strength_model 后写回 ---

/**
 * 从已解析的工作流对象提取所有 LoRA 节点。
 * 判定:节点 inputs 里有非空 lora_name,且 strength_model 是 number(或可转 number 的 string)。
 * 返回 [{ nodeId, loraName, strengthModel }];无效对象返回 []。
 */
function extractLorasFromParsed(parsed) {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];

    const rows = [];
    for (const [nodeId, node] of Object.entries(parsed)) {
        if (!node || typeof node !== 'object' || Array.isArray(node)) continue;
        const inputs = node.inputs;
        if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) continue;
        const loraName = inputs.lora_name;
        if (typeof loraName !== 'string' || !loraName) continue;
        let strength = inputs.strength_model;
        if (typeof strength === 'string' && strength.trim() !== '' && Number.isFinite(Number(strength))) {
            strength = Number(strength);
        }
        if (typeof strength !== 'number' || !Number.isFinite(strength)) continue;
        rows.push({ nodeId, loraName, strengthModel: strength });
    }
    return rows;
}

/** 从工作流 JSON 文本提取所有 LoRA 节点;空文本 / JSON 无效返回 []。 */
function extractLorasFromWorkflow(jsonText) {
    if (!jsonText || !jsonText.trim()) return [];
    let parsed;
    try {
        parsed = JSON.parse(jsonText);
    } catch {
        return [];
    }
    return extractLorasFromParsed(parsed);
}

/** 从 openIdx 的 '{' 起扫描,返回匹配闭合 '}' 的 index(处理字符串/转义);失败返回 -1 */
function findMatchingBrace(str, openIdx) {
    let depth = 0;
    let inStr = false;
    let escaped = false;
    for (let i = openIdx; i < str.length; i++) {
        const ch = str[i];
        if (inStr) {
            if (escaped) { escaped = false; continue; }
            if (ch === '\\') { escaped = true; continue; }
            if (ch === '"') inStr = false;
            continue;
        }
        if (ch === '"') { inStr = true; continue; }
        if (ch === '{') { depth++; continue; }
        if (ch === '}') {
            depth--;
            if (depth === 0) return i;
        }
    }
    return -1;
}

/**
 * 字符串级定位替换:只改 nodeId 节点里的 "strength_model" 值,保留原 JSON 排版。
 * 找不到节点/字段时原样返回原文本。
 */
function setLoraStrengthInJson(jsonText, nodeId, newStrength) {
    const keyRe = new RegExp(`("${escapeRegExp(nodeId)}"\\s*:\\s*\\{)`);
    const m = keyRe.exec(jsonText);
    if (!m) return jsonText;
    const openIdx = m.index + m[1].length - 1; // '{' 的位置
    const closeIdx = findMatchingBrace(jsonText, openIdx);
    if (closeIdx < 0) return jsonText;

    const nodeText = jsonText.slice(openIdx, closeIdx + 1);
    const newText = nodeText.replace(/"strength_model"\s*:\s*("(?:[^"\\]|\\.)*"|-?[\d.]+(?:[eE][+-]?\d+)?)/, (m, oldVal) => {
        // 原值带引号(如 "0.8" 字符串)→ 保持字符串类型,避免静默改 JSON 结构
        const quoted = oldVal.startsWith('"');
        return `"strength_model": ${quoted ? `"${newStrength}"` : newStrength}`;
    });
    if (newText === nodeText) return jsonText;
    return jsonText.slice(0, openIdx) + newText + jsonText.slice(closeIdx + 1);
}

// --- LoRA 节点增删:对工作流 JSON 做图手术(链尾插入 / 删除旁路重接) ---

/** 解析当前工作流文本;空/无效时 toastr 报错并返回 null */
function parseActiveWorkflow() {
    const text = ($('#comfy_workflow').val() || '').trim();
    if (!text) { toastr.error('工作流 JSON 为空,无法操作 LoRA'); return null; }
    try { return JSON.parse(text); }
    catch (e) { toastr.error(`工作流 JSON 无效:${e.message}`); return null; }
}

/**
 * 把全图里引用 [fromId, slot] 的输入改指到 slotReplacer(slot) 返回的新 ref。
 * replacer 返回 undefined 表示该 slot 不动。返回替换次数。
 */
function repointWorkflowRefs(parsed, fromId, slotReplacer) {
    const from = String(fromId);
    let count = 0;
    for (const node of Object.values(parsed)) {
        const inputs = node?.inputs;
        if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) continue;
        for (const [key, val] of Object.entries(inputs)) {
            if (Array.isArray(val) && val.length === 2 && String(val[0]) === from && typeof val[1] === 'number') {
                const to = slotReplacer(val[1]);
                if (to) { inputs[key] = to; count++; }
            }
        }
    }
    return count;
}

/** 写回工作流(DOM + preset + 持久化 + 重新校验并刷新 LoRA 列表) */
function commitWorkflowJson(parsed, preset) {
    const newText = JSON.stringify(parsed, null, 2);
    $('#comfy_workflow').val(newText);
    preset.workflowJson = newText;
    saveSettingsDebounced();
    validateComfyWorkflow();
}

/**
 * 新增 LoRA 节点:插到模型链最下游(离采样器最近的 LoRA 之后;无 LoRA 时接在采样器的 model 源上)。
 * class_type 沿用链上已有 LoRA 节点(LoraLoader 会一并接好 clip),否则用 LoraLoaderModelOnly。
 */
function addLoraToWorkflow(loraName) {
    const preset = getActivePreset();
    if (!preset) return;
    const name = String(loraName || '').trim();
    if (!name) return;
    const parsed = parseActiveWorkflow();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;

    const loras = extractLorasFromParsed(parsed);
    // 链尾 = 输出没有被其他 LoRA 节点当作 model 输入消费的那个 LoRA
    let tail = null;
    if (loras.length) {
        const upstreamRefs = new Set(loras.map(l => {
            const ref = parsed[l.nodeId]?.inputs?.model;
            return Array.isArray(ref) ? `${ref[0]}\u0000${ref[1]}` : null;
        }).filter(Boolean));
        tail = loras.find(l => !upstreamRefs.has(`${l.nodeId}\u00000`)) || loras[0];
    }

    let sourceRef;      // 新 LoRA 的 model 输入指向(插在它的下游)
    let cls = 'LoraLoaderModelOnly';
    let clipRef;
    if (tail) {
        sourceRef = [String(tail.nodeId), 0];
        cls = parsed[tail.nodeId]?.class_type || cls;
        if (cls === 'LoraLoader') {
            clipRef = parsed[tail.nodeId]?.inputs?.clip;
            if (!Array.isArray(clipRef)) { cls = 'LoraLoaderModelOnly'; clipRef = undefined; }
        }
    } else {
        // 无 LoRA:从任意带 model 引用输入的节点(采样器等)找模型源头
        for (const node of Object.values(parsed)) {
            const ref = node?.inputs?.model;
            if (Array.isArray(ref) && parsed[String(ref[0])]) { sourceRef = [String(ref[0]), ref[1]]; break; }
        }
        if (!sourceRef) { toastr.error('工作流中找不到模型链(Loader/采样器),无法插入 LoRA'); return; }
    }

    // 新节点 id:数值 key 最大值 + 1(避免撞已有 key)
    const newId = String(Object.keys(parsed).reduce((m, k) => Math.max(m, Number.parseInt(k, 10) || 0), 0) + 1);

    // 先重接消费方(引用 sourceRef 的 → 指向新节点),再挂新节点(避免误改新节点自己的 model)
    repointWorkflowRefs(parsed, sourceRef[0], slot => {
        if (slot === sourceRef[1]) return [newId, 0];
        if (cls === 'LoraLoader' && slot === 1) return [newId, 1];
        return undefined;
    });

    const inputs = { lora_name: name, strength_model: 1, model: [sourceRef[0], sourceRef[1]] };
    if (cls === 'LoraLoader') { inputs.strength_clip = 1; inputs.clip = clipRef; }
    parsed[newId] = { inputs, class_type: cls };

    commitWorkflowJson(parsed, preset);
}

/** 删除 LoRA 节点:消费方旁路重接到该节点的上游(model/clip) */
function removeLoraFromWorkflow(nodeId) {
    const preset = getActivePreset();
    if (!preset || nodeId === undefined || nodeId === null) return;
    const parsed = parseActiveWorkflow();
    if (!parsed) return;
    const node = parsed[String(nodeId)];
    if (!node || typeof node !== 'object') return;

    const modelRef = Array.isArray(node.inputs?.model) ? node.inputs.model : null;
    const clipRef = Array.isArray(node.inputs?.clip) ? node.inputs.clip : null;
    delete parsed[String(nodeId)];
    repointWorkflowRefs(parsed, nodeId, slot =>
        slot === 0 ? modelRef : (slot === 1 ? clipRef : undefined));

    commitWorkflowJson(parsed, preset);
}

let loraRenderSig = null;

/**
 * 渲染 LoRA 强度编辑列表(从 #comfy_workflow 当前文本提取)。
 * @param {object|null} parsed 可选的已解析工作流对象(validate 已解析过一次,复用避免二次 JSON.parse);缺省时自行解析。
 */
function renderLoraEditor(parsed) {
    const $wrap = $('#comfy_lora_wrap');
    if (!$wrap.length) return;

    const preset = getActivePreset();
    if (!preset) {
        $wrap.css('display', 'none');
        loraRenderSig = null;
        closeLoraAddRow();
        return;
    }
    $wrap.css('display', 'block');

    // 指纹守卫:preset + 工作流文本都没变 → 列表已是最新,跳过重建
    const jsonText = $('#comfy_workflow').val() || '';
    const sig = preset.name + '\u0000' + jsonText;
    if (sig === loraRenderSig) return;
    loraRenderSig = sig;

    const rows = parsed !== undefined
        ? extractLorasFromParsed(parsed)
        : extractLorasFromWorkflow(jsonText);
    const $list = $('#comfy_lora_list');
    const $empty = $('#comfy_lora_empty');

    $list.empty();
    if (rows.length === 0) {
        $list.css('display', 'none');
        $empty.css('display', 'block');
        return;
    }
    $list.css('display', 'flex');
    $empty.css('display', 'none');

    for (const row of rows) {
        const name = escapeHtmlAttribute(row.loraName);
        $list.append(`
            <div class="mag-lora-row">
                <span class="mag-lora-name" title="${name}">${name}</span>
                <input type="number" class="text_pole mag-lora-strength" step="0.05" value="${row.strengthModel}" data-node-id="${escapeHtmlAttribute(row.nodeId)}">
                <div class="menu_button menu_button_icon mag-lora-delete" data-node-id="${escapeHtmlAttribute(row.nodeId)}" title="移除" data-i18n="[title]mag_lora_remove"><i class="fa-solid fa-xmark interactable"></i></div>
            </div>
        `);
    }
}

/** 绑定 LoRA 强度输入 change + 行删除 + 新增下拉(事件委托到容器,列表重渲染后不失效) */
function bindLoraEvents() {
    $('#comfy_lora_list').off('change.lora').on('change.lora', '.mag-lora-strength', function () {
        const nodeId = $(this).attr('data-node-id');
        const preset = getActivePreset();
        if (!preset || !nodeId) return;
        const raw = $(this).val().trim();
        const strength = Number(raw);
        if (raw === '' || !Number.isFinite(strength)) {
            // 空/非法输入 → 只还原这一个输入框为 JSON 里的当前值(不整表重建)
            const row = extractLorasFromWorkflow($('#comfy_workflow').val() || '').find(r => r.nodeId === nodeId);
            if (row) $(this).val(row.strengthModel);
            return;
        }
        const jsonText = $('#comfy_workflow').val() || '';
        const newText = setLoraStrengthInJson(jsonText, nodeId, strength);
        if (newText === jsonText) return;
        $('#comfy_workflow').val(newText);
        preset.workflowJson = newText;
        saveSettingsDebounced();
    });

    $('#comfy_lora_list').off('click.loraDelete').on('click.loraDelete', '.mag-lora-delete', function () {
        removeLoraFromWorkflow($(this).attr('data-node-id'));
    });

    $('#comfy_lora_add_btn').off('click.lora').on('click.lora', function () {
        toggleLoraAddRow();
    });
    $('#comfy_lora_add_input').off('input.lora keydown.lora')
        .on('input.lora', renderLoraAddDropdown)
        .on('keydown.lora', function (e) {
            if (e.key === 'Enter') { e.preventDefault(); confirmLoraAdd(); }
            else if (e.key === 'Escape') { closeLoraAddRow(); }
        });
    $('#comfy_lora_add_dropdown').off('click.lora').on('click.lora', '.mag-lora-option', function () {
        addLoraToWorkflow($(this).attr('data-name'));
        closeLoraAddRow();
    });
    // 点外部收起新增下拉(排除输入行/按钮自身,防开闭对冲)
    $(document).off('click.loraClose').on('click.loraClose', function (e) {
        if (!$('#comfy_lora_add_row').is(':visible')) return;
        if (!$(e.target).closest('#comfy_lora_add_row, #comfy_lora_add_btn').length) closeLoraAddRow();
    });
}

/** 展开/收起 LoRA 新增行;show 缺省时取反当前状态 */
function toggleLoraAddRow(show) {
    const $row = $('#comfy_lora_add_row');
    const willShow = show === undefined ? !$row.is(':visible') : !!show;
    if (willShow) {
        $row.css('display', 'block');
        renderLoraAddDropdown();
        $('#comfy_lora_add_input').trigger('focus');
    } else {
        closeLoraAddRow();
    }
}

function closeLoraAddRow() {
    $('#comfy_lora_add_row').css('display', 'none');
    $('#comfy_lora_add_input').val('');
    $('#comfy_lora_add_dropdown').empty();
}

/** 渲染新增下拉列表:按输入框关键字过滤 comfyCache.loras(最多 100 条) */
function renderLoraAddDropdown() {
    const $dd = $('#comfy_lora_add_dropdown');
    if (!$dd.length) return;
    const query = ($('#comfy_lora_add_input').val() || '').trim().toLowerCase();
    const all = comfyCache.loras || [];
    $dd.empty();
    if (!all.length) {
        $dd.append('<div class="mag-lora-dd-hint">无 LoRA 列表,请先点上方『连接』按钮拉取;也可直接输入完整文件名后回车</div>');
        return;
    }
    const filtered = all.filter(n => String(n).toLowerCase().includes(query));
    if (!filtered.length) {
        $dd.append('<div class="mag-lora-dd-hint">无匹配项</div>');
        return;
    }
    const MAX = 100;
    for (const name of filtered.slice(0, MAX)) {
        $dd.append(`<div class="mag-lora-option" data-name="${escapeHtmlAttribute(name)}" title="${escapeHtmlAttribute(name)}">${escapeHtmlAttribute(name)}</div>`);
    }
    if (filtered.length > MAX) {
        $dd.append(`<div class="mag-lora-dd-hint">… 共 ${filtered.length} 项,输入关键字过滤</div>`);
    }
}

/** 回车确认新增:精确匹配 > 唯一过滤项 > 列表为空时用输入原文 */
function confirmLoraAdd() {
    const raw = ($('#comfy_lora_add_input').val() || '').trim();
    if (!raw) return;
    const all = comfyCache.loras || [];
    const q = raw.toLowerCase();
    const exact = all.find(n => String(n).toLowerCase() === q);
    let name = exact;
    if (!name) {
        const filtered = all.filter(n => String(n).toLowerCase().includes(q));
        if (filtered.length === 1) name = filtered[0];
        else if (!all.length) name = raw;
    }
    if (!name) { toastr.info('请从下拉列表中选择一个 LoRA(输入关键字过滤)'); return; }
    addLoraToWorkflow(name);
    closeLoraAddRow();
}

function bindPresetEvents() {
    $('#comfy_preset_new').off('click').on('click', createPreset);
    $('#comfy_preset_dup').off('click').on('click', duplicatePreset);
    $('#comfy_preset_rename').off('click').on('click', renamePreset);
    $('#comfy_preset_delete').off('click').on('click', deletePreset);
    // 委托到 document,renderPresetGallery 重渲染后无需重绑
    $(document).off('click.preset-gallery', '#comfy_preset_gallery .mag-preset-thumb').on('click.preset-gallery', '#comfy_preset_gallery .mag-preset-thumb', function () {
        const name = $(this).attr('data-name');
        if (!name || name === extension_settings[extensionName].activePresetName) return;
        extension_settings[extensionName].activePresetName = name;
        saveSettingsDebounced();
        renderPresetDropdown();
        renderPresetFields();
    });
    $('#comfy_refresh').off('click').on('click', refreshComfyOptions);
    $('#comfy_save').off('click').on('click', async () => {
        if (!getActivePreset()) { toastr.warning('No active preset'); return; }
        try {
            await saveSettings();
            toastr.success('Saved');
        } catch (e) {
            toastr.error(e.message || String(e));
        }
    });
    bindPresetPreviewEvents();
    bindComfyUrlBookmarkEvents();
    bindComfyImportUrlBookmarkEvents();

    // --- 工作流 JSON 占位符帮助 + 实时校验 ---
    $('#comfy_workflow_help').off('click.workflowHelp').on('click.workflowHelp', function (e) {
        e.stopPropagation();  // 防 ST 浮窗"点外部自动收起"
        toggleWorkflowPopover();
    });
    $('#comfy_workflow_popover').off('click.workflowPopover').on('click.workflowPopover', function (e) {
        e.stopPropagation();  // popover 内部点击不触发"点外部关闭"
    });
    $(document).off('click.workflowPopoverClose').on('click.workflowPopoverClose', function (e) {
        const $pop = $('#comfy_workflow_popover');
        if (!$pop.is(':visible')) return;
        if (!$(e.target).closest('#comfy_workflow_popover, #comfy_workflow_help').length) {
            $pop.css('display', 'none');
        }
    });
    $('#comfy_workflow').off('input.workflowValidate').on('input.workflowValidate', function () {
        clearTimeout(_wfValidateTimer);
        _wfValidateTimer = setTimeout(validateComfyWorkflow, 200);
    });
    validateComfyWorkflow();

    // --- 从 URL 导入配置档(workflow/prefix/negative/preview) ---
    $('#comfy_import_btn').off('click.import').on('click.import', fetchAndApplyImportUrl);
    $('#comfy_import_url').off('keydown.import').on('keydown.import', function (e) {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            fetchAndApplyImportUrl();
        }
    });

    bindLoraEvents();
}

// --- 新增: 渲染角色列表UI ---
function renderCharacterTagsList() {
    const container = $('#character_tags_list');
    if (!container.length) return;

    // 编辑模式下跳过重渲,避免 updateUI 触发时清掉用户正在输入的 input/textarea
    if (container.find('.char-tag-row[data-mode="edit"]').length > 0) return;

    container.empty();
    const tagsDict = extension_settings[extensionName].characterTags || {};
    const keys = Object.keys(tagsDict);

    if (keys.length === 0) {
        container.append('<div style="text-align: center; opacity: 0.5; font-size: 0.9em; padding: 10px;" id="empty_tags_tip" data-i18n="No characters added yet.">No characters added yet.</div>');
    } else {
        for (const charName of keys) {
            const tags = tagsDict[charName];
            const escapedName = escapeHtmlAttribute(charName);
            const escapedTags = escapeHtmlAttribute(tags);

            const rowHtml = `
                <div class="char-tag-row" data-name="${escapedName}" data-mode="view">
                    <span class="char-name" title="${escapedName}">${escapedName}</span>
                    <span class="char-tags-preview" title="${escapedTags}">${escapedTags}</span>
                    <div class="menu_button menu_button_icon edit-char-tag-btn" data-name="${escapedName}" title="Edit" data-i18n="[title]mag_char_edit" style="margin: 0; padding: 5px;">
                        <i class="fa-solid fa-pen interactable"></i>
                    </div>
                    <div class="menu_button menu_button_icon delete-char-tag-btn" data-name="${escapedName}" title="Delete" data-i18n="[title]mag_char_delete" style="margin: 0; padding: 5px;">
                        <i class="fa-solid fa-trash interactable"></i>
                    </div>
                </div>
            `;
            container.append(rowHtml);
        }
    }

    // 同步刷新顶部 select 的 options(+ 新角色 + 当前所有角色名)
    const $select = $('#new_char_name_select');
    if ($select.length) {
        const curVal = $select.val();
        $select.empty();
        $select.append(`<option value="" data-i18n="mag_char_new_role">+ 新角色</option>`);
        for (const charName of keys) {
            const escapedName = escapeHtmlAttribute(charName);
            $select.append(`<option value="${escapedName}">${escapedName}</option>`);
        }
        // 若之前选中的角色被删了,val() 会落到空 option,自动回到 "+ 新角色"
        if (curVal && keys.includes(curVal)) {
            $select.val(curVal);
        } else {
            $select.val('');
        }
    }
}

/** 把指定 view 行替换为 edit 模式(点编辑按钮时调用) */
function enterCharTagEditMode($row) {
    const originalName = $row.attr('data-name');
    const tags = extension_settings[extensionName].characterTags[originalName] || '';
    const escapedName = escapeHtmlAttribute(originalName);
    const escapedTags = escapeHtmlAttribute(tags);

    const editHtml = `
        <div class="char-tag-row" data-original-name="${escapedName}" data-mode="edit">
            <input class="text_pole edit-char-name" value="${escapedName}" placeholder="Name">
            <textarea class="text_pole textarea_compact edit-char-tags" rows="2" placeholder="Tags">${escapedTags}</textarea>
            <div class="menu_button menu_button_icon save-char-tag-btn" data-original-name="${escapedName}" title="Save" data-i18n="[title]mag_char_save" style="margin: 0; padding: 5px;">
                <i class="fa-solid fa-check interactable"></i>
            </div>
            <div class="menu_button menu_button_icon cancel-char-tag-btn" title="Cancel" data-i18n="[title]mag_char_cancel" style="margin: 0; padding: 5px;">
                <i class="fa-solid fa-xmark interactable"></i>
            </div>
        </div>
    `;
    $row.replaceWith(editHtml);
    // 聚焦到 name,便于直接改名
    const $newRow = $(`#character_tags_list .char-tag-row[data-original-name="${escapedName}"]`);
    $newRow.find('.edit-char-name').trigger('focus');
}

/** 绑定角色固定特征 tab 的所有事件:toggle / select change / tags blur / add / edit / save / cancel / delete */
function bindCharTagsEvents() {
    const $sel = $('#new_char_name_select');
    const $inp = $('#new_char_name');
    const $tags = $('#new_char_tags');
    const $list = $('#character_tags_list');

    const isSelectMode = () => $sel.css('display') !== 'none';

    $('#toggle_name_mode_btn').off('click.chartag').on('click.chartag', function () {
        if (isSelectMode()) {
            $sel.css('display', 'none');
            $inp.css('display', 'block');
            const v = $sel.val();
            if (v) $inp.val(v);
            $inp.trigger('focus');
        } else {
            $inp.css('display', 'none');
            $sel.css('display', 'block');
            const v = $inp.val().trim();
            const dict = extension_settings[extensionName].characterTags || {};
            const exists = Object.prototype.hasOwnProperty.call(dict, v);
            $inp.val('');
            $sel.val(exists ? v : '');
            $tags.val(exists ? (dict[v] || '') : '');
        }
    });

    $sel.off('change.chartag').on('change.chartag', function () {
        const name = $(this).val();
        if (name) {
            $tags.val(extension_settings[extensionName].characterTags[name] || '');
        } else {
            $sel.css('display', 'none');
            $inp.css('display', 'block');
            $tags.val('');
            $inp.trigger('focus');
        }
    });

    $tags.off('blur.chartag').on('blur.chartag', function () {
        if (!isSelectMode()) return;
        const name = $sel.val();
        if (!name) return;
        const val = $(this).val();
        const dict = extension_settings[extensionName].characterTags || {};
        if (dict[name] !== val) {
            dict[name] = val;
            saveSettingsDebounced();
            renderCharacterTagsList();
        }
    });

    $('#add_char_tag_btn').off('click.chartag').on('click.chartag', function () {
        const selName = $sel.val();
        const inpName = $inp.val().trim();
        const tags = $tags.val().trim();
        const dict = extension_settings[extensionName].characterTags = extension_settings[extensionName].characterTags || {};

        if (isSelectMode()) {
            if (selName) {
                if (!tags) { toastr.warning('Tags 不能为空'); return; }
                dict[selName] = tags;
                saveSettingsDebounced();
                $tags.val('');
                $sel.val('');
                renderCharacterTagsList();
            } else {
                $sel.css('display', 'none');
                $inp.css('display', 'block');
                $inp.trigger('focus');
            }
        } else {
            if (!inpName || !tags) {
                toastr.warning('角色名称和特征 Tags 不能为空');
                return;
            }
            if (Object.prototype.hasOwnProperty.call(dict, inpName)) {
                toastr.warning(`角色 "${inpName}" 已存在,请改名或编辑现有项`);
                return;
            }
            dict[inpName] = tags;
            saveSettingsDebounced();
            $inp.val('');
            $tags.val('');
            $inp.css('display', 'none');
            $sel.css('display', 'block');
            $sel.val('');
            renderCharacterTagsList();
        }
    });

    $list.off('.chartag');
    $list.on('click.chartag', '.edit-char-tag-btn', function () {
        enterCharTagEditMode($(this).closest('.char-tag-row'));
    });
    $list.on('click.chartag', '.delete-char-tag-btn', function () {
        const nameToDelete = $(this).attr('data-name');
        if (!nameToDelete) return;
        const dict = extension_settings[extensionName].characterTags || {};
        if (!Object.prototype.hasOwnProperty.call(dict, nameToDelete)) return;
        delete dict[nameToDelete];
        saveSettingsDebounced();
        renderCharacterTagsList();
    });
    $list.on('click.chartag', '.cancel-char-tag-btn', function () {
        renderCharacterTagsList();
    });
    $list.on('click.chartag', '.save-char-tag-btn', function () {
        const $row = $(this).closest('.char-tag-row');
        const originalName = $row.attr('data-original-name');
        const newName = $row.find('.edit-char-name').val().trim();
        const newTags = $row.find('.edit-char-tags').val().trim();
        if (!newName || !newTags) {
            toastr.warning('角色名称和特征 Tags 不能为空');
            return;
        }
        const dict = extension_settings[extensionName].characterTags || {};
        if (newName !== originalName) {
            if (Object.prototype.hasOwnProperty.call(dict, newName)) {
                toastr.warning(`角色 "${newName}" 已存在`);
                return;
            }
            // 改名:先删旧 key 再加新 key(防同字典并发)
            delete dict[originalName];
            dict[newName] = newTags;
        } else {
            dict[newName] = newTags;
        }
        saveSettingsDebounced();
        renderCharacterTagsList();
    });
}

function updateUI() {
    if ($('#mediaType').length) {
        $('#mediaType').val(extension_settings[extensionName].mediaType);
        $('#image_regex').val(extension_settings[extensionName].imageRegex);
        $('#video_regex').val(extension_settings[extensionName].videoRegex);
        $('#media_style').val(extension_settings[extensionName].style);
        $('#auto_replace').val(extension_settings[extensionName].autoReplace);

        // --- 新增: 更新UI时一并渲染角色列表 ---
        renderCharacterTagsList();

        // --- 新增: 渲染配置档 dropdown 和字段 ---
        renderPresetDropdown();
        renderPresetFields();

        // --- 新增: 渲染图库 ---
        renderGallery();
    }
}

async function loadSettings() {
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    if (Object.keys(extension_settings[extensionName]).length === 0) {
        Object.assign(extension_settings[extensionName], defaultSettings);
    } else {
        for (const key in defaultSettings) {
            if (extension_settings[extensionName][key] === undefined) {
                extension_settings[extensionName][key] = defaultSettings[key];
            }
        }
    }
    // autoReplace 迁移:旧版 boolean(true/false) → 'auto'/'manual' 枚举
    if (typeof extension_settings[extensionName].autoReplace === 'boolean') {
        extension_settings[extensionName].autoReplace = extension_settings[extensionName].autoReplace ? 'auto' : 'manual';
    }
    // 触发正则迁移:含旧 <pic/<video 属性式格式的(含历史默认值——它源码字符串转义有 bug 从未生效
    // ——或用户手配的旧格式)一律换成 [image]/[video] 新默认;已是新格式或无关自定义值不动
    if (typeof extension_settings[extensionName].imageRegex === 'string' && extension_settings[extensionName].imageRegex.includes('<pic')) {
        extension_settings[extensionName].imageRegex = defaultSettings.imageRegex;
    }
    if (typeof extension_settings[extensionName].videoRegex === 'string' && extension_settings[extensionName].videoRegex.includes('<video')) {
        extension_settings[extensionName].videoRegex = defaultSettings.videoRegex;
    }
    // 配置档迁移:确保 comfyPresets 是数组,失效的 activePresetName 回落
    if (!Array.isArray(extension_settings[extensionName].comfyPresets)) {
        extension_settings[extensionName].comfyPresets = [];
    }
    const presets = extension_settings[extensionName].comfyPresets;
    const activeName = extension_settings[extensionName].activePresetName;
    if (activeName && !presets.some(p => p.name === activeName)) {
        extension_settings[extensionName].activePresetName = presets[0]?.name ?? null;
    }
    // 地址簿迁移:确保是数组,字符串/缺字段项规范化为 { name, url }
    if (!Array.isArray(extension_settings[extensionName].comfyUrls)) {
        extension_settings[extensionName].comfyUrls = [];
    } else {
        extension_settings[extensionName].comfyUrls = extension_settings[extensionName].comfyUrls
            .map(item => {
                if (typeof item === 'string') return { name: deriveUrlName(item), url: item };
                if (!item || typeof item !== 'object' || !item.url) return null;
                if (!item.name) item.name = deriveUrlName(item.url);
                return item;
            })
            .filter(Boolean);
    }
    // URL 全局化迁移:各 preset 的 comfyUrl 去重合并进全局地址簿,激活地址取当前激活档
    {
        const gUrls = extension_settings[extensionName].comfyUrls;
        const activePreset = presets.find(p => p.name === extension_settings[extensionName].activePresetName);
        const activeUrl = String(activePreset?.comfyUrl || '').trim();
        for (const p of presets) {
            const v = String(p.comfyUrl || '').trim();
            delete p.comfyUrl;
            if (!v) continue;
            if (!gUrls.some(u => u.url === v)) gUrls.push({ name: deriveUrlName(v), url: v });
        }
        if (!extension_settings[extensionName].activeComfyUrl) {
            extension_settings[extensionName].activeComfyUrl = activeUrl || gUrls[0]?.url || '';
        }
    }
    // detail 接口 URL 历史迁移:确保是字符串数组,过滤空值/非字符串
    if (!Array.isArray(extension_settings[extensionName].comfyImportUrls)) {
        extension_settings[extensionName].comfyImportUrls = [];
    } else {
        extension_settings[extensionName].comfyImportUrls = extension_settings[extensionName].comfyImportUrls
            .filter(s => typeof s === 'string' && s.trim());
    }
    updateUI();
}

function bindSettingsEvents() {
    $('#mediaType').on('change', function () {
        extension_settings[extensionName].mediaType = $(this).val();
        if (extension_settings[extensionName].mediaType === 'video' && !extension_settings[extensionName].style) {
            extension_settings[extensionName].style = 'width:100%;height:auto';
            $('#media_style').val(extension_settings[extensionName].style);
        } else if (extension_settings[extensionName].mediaType === 'image' && !extension_settings[extensionName].style) {
            extension_settings[extensionName].style = 'width:auto;height:auto';
            $('#media_style').val(extension_settings[extensionName].style);
        }
        updateUI();
        saveSettingsDebounced();
    });

    $('#image_regex').on('input', function () { extension_settings[extensionName].imageRegex = $(this).val(); saveSettingsDebounced(); });
    $('#video_regex').on('input', function () { extension_settings[extensionName].videoRegex = $(this).val(); saveSettingsDebounced(); });
    $('#media_style').on('input', function () { extension_settings[extensionName].style = $(this).val(); saveSettingsDebounced(); });
    $('#auto_replace').on('change', function () {
        extension_settings[extensionName].autoReplace = $(this).val();
        saveSettingsDebounced();
        // 切到 auto 时,立即处理当前最后一条消息 — 把已有占位符替换为自动生图。
        // 否则用户切完 auto 后,旧消息里的占位符不会自动触发,得发新消息或刷新才生效。
        if (extension_settings[extensionName].autoReplace === 'auto') {
            processMessageContent(true, false);
        }
    });
    // 生成方式帮助 popover(仿工作流 JSON 占位符帮助的交互)
    $('#auto_replace_help').off('click.arHelp').on('click.arHelp', function (e) {
        e.stopPropagation(); // 防 ST 浮窗"点外部自动收起"
        toggleAutoReplacePopover();
    });
    $('#auto_replace_popover').off('click.arPopover').on('click.arPopover', function (e) {
        e.stopPropagation(); // popover 内部点击不触发"点外部关闭"
    });
    $(document).off('click.arPopoverClose').on('click.arPopoverClose', function (e) {
        const $pop = $('#auto_replace_popover');
        if (!$pop.is(':visible')) return;
        if (!$(e.target).closest('#auto_replace_popover, #auto_replace_help').length) {
            $pop.css('display', 'none');
        }
    });

    // --- 新增: 绑定角色固定特征 tab 全部事件(toggle/select/add/edit/save/cancel/delete) ---
    bindCharTagsEvents();

    // --- 新增: 绑定 ComfyUI 配置档事件 ---
    bindPresetEvents();

    // --- 新增: 绑定 Gallery 缩略图点击 + lightbox ---
    bindGalleryEvents();

    // --- 新增: 绑定测试生成 tab 事件 ---
    bindTestTabEvents();
}

// 设置面板的统一迁移单元:挂在 #mag_settings_root 下,在隐藏 host 与浮窗 body 间 detach 切换。
// 这样 settings.html 始终是单一权威 DOM,ID/事件绑定全程有效,避免重复挂载冲突。
const SETTINGS_ROOT_ID = '#mag_settings_root';
const SETTINGS_HOST_ID = '#mag_settings_host';
const PANEL_BODY_ID = '#media_auto_gen_panel_body';

/** 把 settings root 在浮窗 body 和隐藏 host 之间切换 */
function moveSettingsTo($target) {
    const $root = $(SETTINGS_ROOT_ID);
    if (!$root.length || $.contains($target[0], $root[0])) return;
    $root.detach().appendTo($target);
}

/** 浮标默认位置的尺寸/边距参数(手机端:按钮缩小、bottom 抬高避开 ST 底部 nav) */
function floatBtnMetrics() {
    const mobile = isMobile();
    return {
        mobile,
        size: mobile ? 40 : 48,
        fontSize: mobile ? 18 : 20,
        rightGap: mobile ? 16 : 20,
        bottomGap: mobile ? 90 : 20,
    };
}

/**
 * 把浮标当前位置钳制回视口内(完整可见)。
 * 只改视觉不落盘:手机浏览器地址栏收展/旋屏/桌面改窗口都会变视口,
 * 落盘位置可能把按钮整颗挤出屏幕(看不见也摸不着),这里拉回可拖范围。
 */
function clampFloatBtnIntoView() {
    const $btn = $('#media_auto_gen_float_btn');
    if (!$btn.length) return;
    const elW = $btn.outerWidth();
    const elH = $btn.outerHeight();
    if (!elW || !elH) return;
    const left = parseInt($btn.css('left'), 10) || 0;
    const top = parseInt($btn.css('top'), 10) || 0;
    const clampedLeft = clamp(left, 0, Math.max(0, window.innerWidth - elW));
    const clampedTop = clamp(top, 0, Math.max(0, window.innerHeight - elH));
    if (clampedLeft !== left || clampedTop !== top) {
        $btn.css({ left: clampedLeft + 'px', top: clampedTop + 'px' });
    }
}

/** 把浮标重置回默认位置(右下角,手机端抬高避开底栏)并落盘 */
function resetFloatBtnPosition() {
    const $btn = $('#media_auto_gen_float_btn');
    if (!$btn.length) return;
    const m = floatBtnMetrics();
    const size = $btn.outerWidth() || m.size;
    const left = Math.max(0, window.innerWidth - size - m.rightGap);
    const top = Math.max(0, window.innerHeight - size - m.bottomGap);
    $btn.css({ left: left + 'px', top: top + 'px' });
    setFloatBtnDocked(null); // 同步清吸附运行态,否则闭包外还认为吸附着,下一次点浮标会被当"仅解除吸附"吞掉
    extension_settings[extensionName].floatBtnPosition = { left, top };
    saveSettingsDebounced();
}

// 浮标吸附态(运行时,不持久化,刷新即解除)。模块级而非 initFloatBtnDrag 闭包:
// wand 入口的 resetFloatBtnPosition 也要清它,闭包变量外面够不着。
let floatBtnDockedEdge = null;

function setFloatBtnDocked(edge) {
    floatBtnDockedEdge = edge;
    const $btn = $('#media_auto_gen_float_btn');
    $btn.removeClass('mag-docked-left mag-docked-right');
    if (edge) $btn.addClass('mag-docked-' + edge);
}

function createFloatingUI(settingsHtml) {
    const mobile = isMobile();

    if (!$('#media_auto_gen_float_btn').length) {
        $('body').append(`
            <div id="media_auto_gen_float_btn" title="Media Auto Generation">
                <i class="fa-solid fa-film"></i>
            </div>
        `);
    }
    const $btn = $('#media_auto_gen_float_btn');
    // 手机端样式钩子:吸附时少藏一点(settings.html 的 .mag-mobile 覆盖)
    $btn.toggleClass('mag-mobile', mobile);
    // 手机端:按钮缩小(原 56 偏大);bottom 抬高避开 ST 底部 nav
    const { size: btnSize, fontSize: btnFontSize, rightGap: btnRightGap, bottomGap: btnBottomGap } = floatBtnMetrics();
    $btn.attr('style', [
        'position:fixed',
        'z-index:2147483640',
        `width:${btnSize}px`,
        `height:${btnSize}px`,
        'border-radius:50%',
        'cursor:grab',
        'display:flex',
        'align-items:center',
        'justify-content:center',
        `font-size:${btnFontSize}px`,
        'background:var(--SmartThemeBlurTintColor)',
        'border:1px solid var(--SmartThemeBorderColor)',
        'color:var(--SmartThemeBodyColor)',
        'box-shadow:0 2px 8px rgba(0,0,0,0.3)',
        'user-select:none',
        '-webkit-user-select:none',
        // ST 全局 html { perspective: 1000px } 让 fixed 元素的 right/bottom 失效,
        // 必须用 left/top 像素值(配合 calc(100vw/vh - X))才能正确定位
        `left:calc(100vw - ${btnSize + btnRightGap}px)`,
        `top:calc(100vh - ${btnSize + btnBottomGap}px)`,
        'right:auto',
        'bottom:auto',
    ].join(';') + ';');

    // 恢复持久化的拖动位置(手机端也读,因为手机端现在可拖动且落盘)
    const pos = extension_settings[extensionName].floatBtnPosition;
    if (pos && typeof pos.left === 'number' && typeof pos.top === 'number') {
        $btn.css({ left: pos.left + 'px', top: pos.top + 'px' });
        // 落盘后视口可能已变(手机地址栏收展/旋屏/桌面改窗口),历史位置可能整颗出屏 → 拉回可见
        clampFloatBtnIntoView();
    }

    if (!$('#media_auto_gen_panel').length) {
        // #movingDivs is ST's layer for floating panels; fall back to body if absent
        const mountTarget = $('#movingDivs').length ? $('#movingDivs') : $('body');
        mountTarget.append(`
            <div id="media_auto_gen_panel" class="flex-column">
                <div id="media_auto_gen_panelheader" class="flex-container align_center">
                    <b data-i18n="Media Auto Generation">Media Auto Generation</b>
                    <div id="media_auto_gen_panel_close" class="fa-solid fa-circle-xmark whiteClose" title="Close"></div>
                </div>
                <div id="media_auto_gen_panel_body"></div>
            </div>
        `);
    }
    const $panel = $('#media_auto_gen_panel');
    // 手机端:面板宽度撑满、顶部留出 ST 顶栏空间
    const panelTop = mobile ? '70px' : '100px';
    $panel.attr('style', [
        'position:fixed',
        'z-index:2147483640',
        'display:none',
        'flex-direction:column',
        mobile ? 'width:calc(100vw - 16px)' : 'width:380px',
        'max-width:90vw',
        'max-height:80vh',
        'padding:0',
        'background:var(--SmartThemeBlurTintColor)',
        'border:1px solid var(--SmartThemeBorderColor)',
        'border-radius:10px',
        'box-shadow:0 4px 20px rgba(0,0,0,0.4)',
        // 用 left/top 像素值,绕过 ST html { perspective:1000px } 让 right/bottom 失效的 quirk
        mobile
            ? `left:8px; top:${panelTop}; right:auto`
            : `left:calc(100vw - 400px); top:${panelTop}; right:auto`,
        'bottom:auto',
    ].join(';') + ';');

    $('#media_auto_gen_panelheader').attr('style', [
        'padding:8px 10px',
        'cursor:grab',
        'border-bottom:1px solid var(--SmartThemeBorderColor)',
        'gap:8px',
    ].join(';') + ';');
    $('#media_auto_gen_panelheader > b').css('flex', '1');
    $('#media_auto_gen_panel_close').css({ 'cursor': 'pointer', 'font-size': '20px' });

    $('#media_auto_gen_panel_body')
        .attr('style', 'padding:10px; overflow-y:auto; flex:1;')
        .empty();

    // --- 魔法棒快速菜单入口(#extensionsMenu,消息框旁的扩展菜单) ---
    // 标准 wand 菜单模式:list-group-item + extensionsMenuExtensionButton 图标。
    // 第三方扩展不能写入 wandMenu.html 模板,直接 append 到 #extensionsMenu 即可(参考 yuzuki-phone)。
    if ($('#mag_wand_entry').length === 0 && $('#extensionsMenu').length) {
        $('#extensionsMenu').append(`
            <div id="mag_wand_entry" class="list-group-item flex-container flexGap5" title="Media Auto Generation" data-i18n="[title]Media Auto Generation">
                <div class="fa-solid fa-film extensionsMenuExtensionButton"></div>
                <span data-i18n="Media Auto Generation">Media Auto Generation</span>
            </div>
        `);
    }
    // 点击 wand 入口 → 打开浮窗(DOM 寄居:settings 自动从隐藏寄居容器迁到 panel body)
    // 手机救援通道:浮标吸附在屏幕边缘/被视口变化挤出屏摸不到时,wand 菜单(手机端从左下角
    // 弹出)是兜底入口——每次从这里打开都顺手把浮标重置回默认右下角(抬高避开底栏),下次一定看得见
    $('#mag_wand_entry').off('click.mag').on('click.mag', function () {
        if (mobile) resetFloatBtnPosition();
        toggleFloatingPanel(true);
    });

    // --- 发送栏"媒体预览"入口(#rightSendForm,发送按钮旁,参考 st-phone 的手机图标) ---
    // #rightSendForm 的直接 div 子元素自动获得 ST 图标按钮样式(尺寸/hover),不要用
    // stscript_btn 类(那类按钮默认 display:none,只在执行脚本时显示)
    if ($('#mag_preview_btn').length === 0 && $('#rightSendForm').length) {
        $('#rightSendForm').append(`
            <div id="mag_preview_btn" class="fa-solid fa-images interactable" title="媒体预览" data-i18n="[title]mag_preview_btn_title" tabindex="0" role="button"></div>
        `);
    }
    $('#mag_preview_btn').off('click.mag').on('click.mag', function () {
        openMediaPreviewModal();
    });

    // --- settings.html 的隐藏寄居容器(单一路径,避免重复 DOM 导致 ID 冲突) ---
    // 平时藏在这里,浮窗打开时 detach 到 panel body,关闭时 detach 回来。
    if ($('#mag_settings_host').length === 0) {
        $('body').append(`<div id="mag_settings_host" style="display:none;"></div>`);
    }
    if ($('#mag_settings_root').length === 0) {
        $('#mag_settings_host').append(`<div id="mag_settings_root">${settingsHtml}</div>`);
    }

    $('#media_auto_gen_panel_close').off('click').on('click', function () {
        toggleFloatingPanel(false);
    });

    // 手机端:点面板外空白处收起浮窗。
    // 用 click(手机端 touch 后只合成一次,无 mousedown/touchstart 双触发问题);
    // 排除面板本体与各入口按钮(否则"点入口打开"的同一冒泡 click 会立刻把它关回去)。
    // 原生 <select>(配置档切换等)在手机上选完选项后,浏览器补发的合成 click
    // target 可能不在面板内,会被误判成"点外部"→ 记录面板内 change 时间戳,
    // 短窗口内到达的 click 不视为点外部(同 initFloatBtnDrag 的 lastTouchTs 思路)。
    let lastPanelChangeTs = 0;
    $(document).off('change.magPanelGuard').on('change.magPanelGuard', (e) => {
        if ($(e.target).closest('#media_auto_gen_panel').length) lastPanelChangeTs = Date.now();
    });
    $(document).off('click.magPanelOutside').on('click.magPanelOutside', (e) => {
        if (!isMobile()) return;
        if (Date.now() - lastPanelChangeTs < 600) return;
        const $panel = $('#media_auto_gen_panel');
        if ($panel.css('display') === 'none') return;
        // 面板内控件的 click 处理器若重渲染并销毁了目标元素(如 preset 缩略图切换 →
        // renderPresetGallery 的 $grid.empty()),事件冒泡到 document 时 target 已脱离
        // DOM,closest 查不到面板会被误判"点外部"。脱离 DOM 的 target 必然来自面板内
        // 交互(真实空白点击落在 body/chat 等常驻元素上,不会脱离),直接放行。
        if (!e.target.isConnected) return;
        if ($(e.target).closest('#media_auto_gen_panel, #media_auto_gen_float_btn, #mag_wand_entry').length) return;
        toggleFloatingPanel(false);
    });

    initTabs();
}

function initTabs() {
    // settings 在 #mag_settings_root 里(寄居于浮窗或抽屉),基于它查 tab
    const $root = $(SETTINGS_ROOT_ID);
    const $btns = $root.find('.mag-tab-btn');
    $btns.off('click.tab').on('click.tab', function () {
        const tab = $(this).attr('data-mag-tab');
        $btns.removeClass('active');
        $(this).addClass('active');
        $root.find('.mag-tab-panel').css('display', 'none');
        $root.find(`.mag-tab-panel[data-mag-panel="${tab}"]`).css('display', 'block');
    });
    $btns.first().trigger('click');
}

/**
 * 切换浮窗显示状态(DOM 寄居模式)
 * - 打开:settings root 从隐藏 host detach 到浮窗 body,显示浮窗
 * - 关闭:隐藏浮窗,settings root detach 回隐藏 host
 * - 传 false 强制关闭;传 true 强制打开;不传 = toggle
 */
function toggleFloatingPanel(force) {
    const $p = $('#media_auto_gen_panel');
    const willOpen = typeof force === 'boolean' ? force : ($p.css('display') === 'none');

    if (willOpen) {
        moveSettingsTo($(PANEL_BODY_ID));
        $p.css('display', 'flex');
    } else {
        $p.css('display', 'none');
        moveSettingsTo($(SETTINGS_HOST_ID));
    }
}

function initPanelDrag() {
    const $panel = $('#media_auto_gen_panel');
    const $handle = $('#media_auto_gen_panelheader');
    let startX = 0, startY = 0;
    let originLeft = 0, originTop = 0;
    let elW = 0, elH = 0;
    let dragging = false;

    function getPoint(e) {
        return (e.touches && e.touches[0]) ? e.touches[0] : e;
    }

    $handle.on('mousedown touchstart', function (e) {
        if (e.target.id === 'media_auto_gen_panel_close') return;
        const p = getPoint(e);
        startX = p.clientX;
        startY = p.clientY;
        const offset = $panel.offset();
        originLeft = offset.left;
        originTop = offset.top;
        elW = $panel.outerWidth();
        elH = $panel.outerHeight();
        dragging = false;

        function onMove(ev) {
            const pp = getPoint(ev);
            const dx = pp.clientX - startX;
            const dy = pp.clientY - startY;
            if (!dragging && (Math.abs(dx) > 5 || Math.abs(dy) > 5)) {
                dragging = true;
                $panel.css({ right: 'auto', bottom: 'auto', cursor: 'grabbing' });
                $handle.css('cursor', 'grabbing');
            }
            if (dragging) {
                const newLeft = clamp(originLeft + dx, 0, window.innerWidth - elW);
                const newTop = clamp(originTop + dy, 0, window.innerHeight - elH);
                $panel.css({ left: newLeft + 'px', top: newTop + 'px' });
                if (ev.cancelable) ev.preventDefault();
            }
        }

        function onUp() {
            $(document).off('mousemove touchmove', onMove);
            $(document).off('mouseup touchend touchcancel', onUp);
            $handle.css('cursor', 'grab');
            if (dragging) $panel.css('cursor', '');
        }

        $(document).on('mousemove touchmove', onMove);
        $(document).on('mouseup touchend touchcancel', onUp);
    });
}

function initFloatBtnDrag() {
    const btn = $('#media_auto_gen_float_btn');
    const EDGE_THRESHOLD = 20;  // 距屏幕左右边 ≤20px 松手 → 吸附

    let startX = 0, startY = 0;
    let originLeft = 0, originTop = 0;
    let elW = 0, elH = 0;
    let isDragging = false;
    let wasDocked = false;
    let lastTouchTs = 0;  // 阻止手机端 touchend 后浏览器合成的 mouse 兼容事件双触发

    function getPoint(e) {
        return (e.touches && e.touches[0]) ? e.touches[0] : e;
    }

    // 视口变化(手机地址栏收展/旋屏/桌面改窗口)时把浮标拉回可见范围,防止挤出屏幕后摸不着
    $(window).off('resize.magFloatBtn orientationchange.magFloatBtn')
        .on('resize.magFloatBtn orientationchange.magFloatBtn', clampFloatBtnIntoView);

    btn.on('mousedown touchstart', function (e) {
        // 手机端:touchend 后浏览器会自动合成 mousedown/mouseup/click,
        // 不去重会导致 toggleFloatingPanel 被调 2 次(先开后关,用户看到"闪一下又消失")
        if (e.type === 'touchstart') {
            lastTouchTs = Date.now();
        } else if (Date.now() - lastTouchTs < 500) {
            return;
        }

        // 若吸附态:先解除 + 立即关 transition,避免拖动首帧被 .18s 过渡抢跑导致位置跳变;
        // 记 wasDocked 供 onUp 区分"残影 click"与"普通 click"
        wasDocked = floatBtnDockedEdge !== null;
        if (floatBtnDockedEdge) {
            setFloatBtnDocked(null);
            btn.addClass('mag-dragging');
        }

        const p = getPoint(e);
        startX = p.clientX;
        startY = p.clientY;
        const offset = btn.offset();
        originLeft = offset.left;
        originTop = offset.top;
        elW = btn.outerWidth();
        elH = btn.outerHeight();
        isDragging = false;

        function onMove(ev) {
            const pp = getPoint(ev);
            const dx = pp.clientX - startX;
            const dy = pp.clientY - startY;
            if (!isDragging && (Math.abs(dx) > 10 || Math.abs(dy) > 10)) {
                isDragging = true;
                btn.addClass('mag-dragging').css({ right: 'auto', bottom: 'auto', cursor: 'grabbing' });
            }
            if (isDragging) {
                const newLeft = clamp(originLeft + dx, 0, window.innerWidth - elW);
                const newTop = clamp(originTop + dy, 0, window.innerHeight - elH);
                btn.css({ left: newLeft + 'px', top: newTop + 'px' });
                if (ev.cancelable) ev.preventDefault();
            }
        }

        function onUp() {
            $(document).off('mousemove touchmove', onMove);
            $(document).off('mouseup touchend touchcancel', onUp);
            btn.removeClass('mag-dragging').css('cursor', 'grab');

            if (!isDragging) {
                // 吸附态下点击只解除(已在 touchstart 完成),不开面板
                if (!wasDocked) toggleFloatingPanel();
                return;
            }

            // 拖动结束:检测左右吸附
            const left = parseInt(btn.css('left'), 10) || 0;
            const vw = window.innerWidth;
            const distLeft = left;
            const distRight = vw - left - elW;

            if (distRight <= EDGE_THRESHOLD && distRight <= distLeft) {
                setFloatBtnDocked('right');
            } else if (distLeft <= EDGE_THRESHOLD) {
                setFloatBtnDocked('left');
            }

            // 位置无论吸附与否都落盘(left/top 是吸附前的真实位置,刷新后从此处可见态开始)
            extension_settings[extensionName].floatBtnPosition = {
                left: left,
                top: parseInt(btn.css('top'), 10) || 0,
            };
            saveSettingsDebounced();
        }

        $(document).on('mousemove touchmove', onMove);
        $(document).on('mouseup touchend touchcancel', onUp);
    });
}

$(function () {
    (async function () {
        const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
        await loadSettings();
        createFloatingUI(settingsHtml);
        bindSettingsEvents();
        updateUI();
        initPanelDrag();
        initFloatBtnDrag();
    })();
});

// --- 核心处理逻辑 ---

/**
 * 请求一次防抖更新
 */
function requestDebouncedUpdate(isFinal = false) {
    if (updateDebounceTimer) clearTimeout(updateDebounceTimer);
    updateDebounceTimer = setTimeout(async () => {
        updateDebounceTimer = null;
        try {
            // 先落地 in-flight:标签变成品后带 src 会被扫描跳过,
            // 避免后续 final 扫描因冷却恰好过期而对同一标签重复触发生成
            const landed = await landInFlightMedia();
            await processMessageContent(isFinal, false); // 占位符 / 失败降级 / 触发生成
            if (landed > 0) {
                await getContext().saveChat();
            }
        } catch (e) {
            console.error(`[${extensionName}] debounced update failed:`, e);
        }
    }, 200); // 200ms 缓冲
}

/**
 * 把 in-flight 媒体落地到**各自触发时的楼层**(不依赖"最后一楼")。
 * 生成耗时 40s+,完成时触发楼常已被用户新消息挤到非最后一楼——原来只在最后一楼
 * 扫描循环里消费 inFlightMedia,导致媒体滞留被冲掉、标签永久卡死(需刷新重新生成)。
 * 匹配:优先 originalTag 原文精确匹配(流式只追加不改前缀);失配再用 regexStr+hash
 * 重扫兜底(防御用户 regex 脚本在流式结束后改写 mes 文本)。都失配 = 楼层被 swipe/删除
 * → 丢弃条目防泄漏(接管原 GENERATION_STARTED 盲清 inFlightMedia 的职责)。
 * 流式期间只滞留"流式目标楼(最后一楼)"——它的 mes 被 ST 持续重写,中途写会被冲掉;
 * 非流式楼(生成耗时 40s+,触发楼常已被挤到非最后一楼)照常落地。
 * @returns {number} 本次落地条数
 */
async function landInFlightMedia() {
    if (inFlightMedia.size === 0) return 0;
    const chat = getContext().chat || [];
    const s = extension_settings[extensionName];
    const stats = { image: 0, video: 0 };
    let landed = 0;

    for (const [promptHash, entry] of [...inFlightMedia]) {
        // 只滞留"正在被流式重写的楼"(最后一楼):此刻写 mes 会被 ST 的流式重写冲掉,
        // 留给 GENERATION_ENDED 防抖 / 完成回调下次落地。非流式楼不受流式影响,照常落地。
        // (原先顶层 isStreamActive 一票否决,流式结束事件一旦丢失/时序异常,媒体永久滞留,
        // 标签永不替换——2026-08 实测事故:生成成功入图库但零落地)
        if (isStreamActive && entry.floor === chat.length - 1) continue;
        const msg = chat[entry.floor];
        if (!msg || msg.is_user || typeof msg.mes !== 'string') {
            console.warn(`[${extensionName}] in-flight 媒体楼层无效(floor=${entry.floor}),丢弃`);
            inFlightMedia.delete(promptHash);
            continue;
        }

        let replaced = false;
        if (entry.originalTag && msg.mes.includes(entry.originalTag)) {
            msg.mes = replaceLiteral(msg.mes, entry.originalTag, entry.mediaTag);
            replaced = true;
        } else if (entry.regexStr) {
            // hash 兜底重扫:prompt 提取 / 特征注入 / occ 计数与 processMessageContent 逻辑 B 一致
            const tagRegex = regexFromString(entry.regexStr);
            const seen = new Map();
            for (const m of msg.mes.matchAll(tagRegex)) {
                // 守卫:跳过占位符/wrapper 属性里携带的标签文本(同 processMessageContent)
                if (isInsideHtmlTag(msg.mes, m.index)) continue;
                let rawPrompt = extractTagPrompt(m);
                if (!rawPrompt) continue;
                const base = simpleHash(normalizePrompt(injectCharacterTags(rawPrompt, s.characterTags).modifiedPrompt));
                const occ = seen.get(base) || 0;
                seen.set(base, occ + 1);
                if ((occ > 0 ? `${base}#${occ}` : base) === promptHash) {
                    msg.mes = replaceLiteral(msg.mes, m[0], entry.mediaTag);
                    replaced = true;
                    break;
                }
            }
        }

        inFlightMedia.delete(promptHash); // 无论成败都消费:失配条目留着必泄漏
        if (!replaced) {
            console.warn(`[${extensionName}] in-flight 媒体未找到落点(楼层已被 swipe/删除?),丢弃`);
            continue;
        }

        updateMessageBlock(entry.floor, msg);
        if (entry.mediaTag.includes('<video')) stats.video++;
        else stats.image++;
        landed++;
        await eventSource.emit(event_types.MESSAGE_UPDATED, entry.floor);
    }

    if (landed > 0) {
        scheduleMediaPreviewRender(); // in-flight 转正式楼层记录 → 预览浮窗跟进
        const parts = [];
        if (stats.image > 0) parts.push(`${stats.image} 张图片`);
        if (stats.video > 0) parts.push(`${stats.video} 个视频`);
        toastr.success(`替换完成: ${parts.join(', ')}`);
    }
    return landed;
}

/**
 * 处理消息内容
 * @param {boolean} isFinal 是否是最终检查
 * @param {boolean} onlyTrigger true=只触发生成不修改界面; false=允许修改界面
 */
async function processMessageContent(isFinal = false, onlyTrigger = false) {
    if (!extension_settings[extensionName] || extension_settings[extensionName].mediaType === 'disabled') return;

    const autoReplace = extension_settings[extensionName].autoReplace !== 'manual';
    // 手动模式下,流式期间只触发生成(onlyTrigger=true)无意义,直接 return 避免抖动;
    // 占位符的渲染交给流式结束后的最终处理。
    if (onlyTrigger && !autoReplace) return;

    const context = getContext();
    const messageIndex = context.chat.length - 1;
    const message = context.chat[messageIndex];

    if (!message || message.is_user || !message.mes) return;

    const mediaType = extension_settings[extensionName].mediaType;
    const regexStr = mediaType === 'image' ? extension_settings[extensionName].imageRegex : extension_settings[extensionName].videoRegex;
    if (!regexStr) return;

    const mediaTagRegex = regexFromString(regexStr);
    // 快照 mes:生成为异步,期间流式会持续重写 message.mes,match.index / declare 位置都锚定在此快照上
    const mesText = message.mes;
    const matches = [...mesText.matchAll(mediaTagRegex)];
    if (matches.length === 0) return;
    if (isFinal) console.log(`[${extensionName}] 最终扫描: 楼${messageIndex} 匹配 ${matches.length} 个标签`);

    let contentModified = false;
    let currentMessageText = message.mes;

    // 同消息内同 prompt 出现 N 次时,各自独立 hash 避免 processingHashes 锁互相命中:
    // 否则 7 个 [image]1girl[/image] 全部同一 promptHash → 第 1 个 add 锁后,后 6 个
    // 都被 has 拦 continue,不生成(用户期望 7 张不同图,seed 随机)。
    const seenInThisMsg = new Map(); // baseHash → 出现次数

    // 使用 entries() 获取当前是第几个匹配项 (index)
    for (const [index, match] of matches.entries()) {
        // 守卫:跳过位于 HTML 标签内部的匹配——占位符 data-original-tag 属性里存着裸标签
        // 原文,不拦的话重扫会把属性里的标签再当正文标签,嵌套出新占位符把消息渲染搞成源码
        // (见 isInsideHtmlTag 注释)。wrapper 的 data-prompt(prompt 含标签文本)同样被拦。
        if (isInsideHtmlTag(mesText, match.index)) {
            if (isFinal) console.log(`[${extensionName}] 跳过标签内部的匹配(占位符/wrapper 属性携带): ${match[0].slice(0, 50)}`);
            continue;
        }

        const originalTag = match[0];

        let rawPrompt = extractTagPrompt(match);

        if (!rawPrompt) continue;

        // 流式期间(isFinal=false)只认成对分支(组1):漏闭合兜底分支(组2)会把半截流式输出
        // 当成漏闭合标签——每轮轮询 prompt 都在变长 → hash 每轮不同 → 冷却/并发锁全失效,
        // 疯狂重复触发生成;落地时半截 originalTag 又是完整标签的前缀,前缀替换会留下
        // [/image] 残尾。兜底分支只在消息完整后(GENERATION_ENDED / MESSAGE_RECEIVED /
        // MESSAGE_EDITED 的 isFinal=true)生效。
        if (!isFinal && !match[1]) continue;

        // --- 新增: 角色固定特征拦截与注入 ---
        const injectionResult = injectCharacterTags(rawPrompt, extension_settings[extensionName].characterTags);
        const modifiedPrompt = injectionResult.modifiedPrompt;

        // 打印日志：仅在成功注入且非流式频繁检测时打印，避免刷屏
        if (injectionResult.injected && !onlyTrigger) {
            console.log(`[${extensionName}] 🎯 角色特征匹配成功，已自动注入！`);
            console.log(`[${extensionName}] Original Prompt:`, rawPrompt);
            console.log(`[${extensionName}] Modified Prompt:`, modifiedPrompt);
        }

        // 注意：使用注入后的 modifiedPrompt 计算 Hash，确保特征修改后能重新生成
        const baseHash = simpleHash(normalizePrompt(modifiedPrompt));
        const occ = seenInThisMsg.get(baseHash) || 0;
        seenInThisMsg.set(baseHash, occ + 1);
        // occ>0 加后缀让同消息内第 2/3/... 个相同 prompt 各自独立 hash,绕过 processingHashes
        // 并发锁(否则第 1 个 add 后,后 6 个都被 has 拦 continue,不生成)
        const promptHash = occ > 0 ? `${baseHash}#${occ}` : baseHash;

        // --- 逻辑 A：已废除,媒体落地统一改走 landInFlightMedia() ---
        // 原实现按 promptHash 消费 inFlightMedia,但只在"最后一楼"的扫描循环里跑:
        // 生成耗时 40s+,完成时触发楼常已被用户的新消息挤到非最后一楼 → 媒体滞留 inFlightMedia
        // 被下一轮 GENERATION_STARTED clear() 冲掉 → 标签永久卡死,只能刷新(清冷却)后重新生成。
        // landInFlightMedia 按 entry.floor + originalTag 精确定位,见其注释。

        // --- 逻辑 A-1：失败降级(自动模式 ComfyUI 失败,流式结束后渲染 error 占位符让用户手动重试)---
        if (!onlyTrigger && failedPrompts.has(promptHash)) {
            const placeholder = buildPlaceholder({ promptHash, index, mediaType, rawPrompt, originalTag, state: 'error', error: failedPrompts.get(promptHash) });
            currentMessageText = replaceLiteral(currentMessageText, originalTag, placeholder);
            contentModified = true;
            continue;
        }

        // --- 逻辑 B-0：手动模式占位符 ---
        // autoReplace='manual' 时,把 originalTag 替换为可点击占位符,不触发生成。
        // 用户点击占位符 → onPlaceholderClick → 触发生成 → 用 magId 字符串替换为最终 <img>/<video>。
        if (!autoReplace) {
            const placeholder = buildPlaceholder({ promptHash, index, mediaType, rawPrompt, originalTag, state: 'idle' });
            currentMessageText = replaceLiteral(currentMessageText, originalTag, placeholder);
            contentModified = true;
            continue;
        }

        // --- 逻辑 B：触发新生成 ---
        if (processingHashes.has(promptHash)) continue;

        const now = Date.now();
        if (promptHistory.has(promptHash)) {
            const lastGenTime = promptHistory.get(promptHash);
            if (now - lastGenTime < PROMPT_COOLDOWN_MS) continue;
        }

        console.log(`[${extensionName}] 触发生成: ${mediaType} hash=${String(promptHash).slice(0, 12)} floor=${messageIndex} isFinal=${isFinal} prompt=${modifiedPrompt.slice(0, 60)}`);
        processingHashes.add(promptHash);
        promptHistory.set(promptHash, now);

        // 异步生成任务
        (async () => {
            let timer;
            let seconds = 0;
            let toast = null;

            try {
                const mediaTypeText = mediaType === 'image' ? '图片' : '视频';
                const toastrOptions = { timeOut: 0, extendedTimeOut: 0, closeButton: true };

                // 【修改点】：只显示当前是第几张 (基于文本顺序)，不显示未知总数
                const baseText = `⏳ 生成第 ${index + 1} 张${mediaTypeText}...`;
                toast = toastr.info(`${baseText} ${seconds}s`, '', toastrOptions);

                timer = setInterval(() => {
                    seconds++;
                    if (toast && toast.find) {
                        toast.find('.toast-message').text(`${baseText} ${seconds}s`);
                    }
                }, 1000);

                // 直接调远程 ComfyUI(走 ST 后端代理 /api/sd/comfy/generate)
                const { url, format, character, finalPrompt } = await generateViaComfy(modifiedPrompt, mediaType);

                clearInterval(timer);
                if (toast) toastr.clear(toast);

                // format 与 mediaType 不匹配只警告,不阻断
                const isVideoFormat = VIDEO_FORMATS.has(format);
                if (mediaType === 'video' && !isVideoFormat) {
                    toastr.warning(`ComfyUI returned image format "${format}" but media type is video; tag may not render.`);
                } else if (mediaType === 'image' && isVideoFormat) {
                    toastr.warning(`ComfyUI returned video format "${format}" but media type is image; tag may not render.`);
                }

                // 自动模式也走 wrapper(与手动模式一致),用 promptHash+index+时间戳生成 magId
                const autoMagId = `${promptHash}-${index}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
                const mediaTag = buildMediaWrap({
                    magId: autoMagId,
                    mediaType,
                    url,
                    rawPrompt,
                });

                // 暂存到 inFlightMedia → landInFlightMedia() 按触发楼层落地 DOM。
                // declare 在触发时刻的 mes 快照上按标签位置捕获(declare 位于 [image]/[video] 标签之前,
                // 标签能被匹配到时它必已完整输出):流式期间 mes 里还没有 wrapper,
                // 媒体预览浮窗只能靠这里带出描述,否则要等整条回复结束才可见。
                // floor/originalTag:生成完成时该楼可能已不是最后一楼(用户已发下一条消息),
                // 必须靠它们精确定位,否则媒体永不落地(裸标签卡死 + 撞冷却,只能刷新)。
                inFlightMedia.set(promptHash, {
                    mediaTag,
                    declare: declareForPosition([...mesText.matchAll(PIC_DECLARE_RE)], mesText, match.index),
                    floor: messageIndex,
                    originalTag,
                    regexStr,
                });
                console.log(`[${extensionName}] 生成成功: hash=${String(promptHash).slice(0, 12)} floor=${messageIndex} isStreamActive=${isStreamActive}`);
                failedPrompts.delete(promptHash); // 兜底:同一 prompt 先失败后(在另一消息)自动成功,清残留失败记录

                // 记录到图库 manifest(供 Gallery tab 展示)。prompt 用 finalPrompt 快照(含前缀+角色注入)
                pushGalleryEntry({ url, character, prompt: finalPrompt, mediaType, format });

                // 成功后立即解锁
                processingHashes.delete(promptHash);

                // 非流式:每张完成立即落地(绕开 200ms 防抖,避免多张同时完成被合并成一次"等齐"显示)
                // 流式:GENERATION_ENDED 的防抖会统一落地;这里再挂 10s 延迟重试兜底——
                // 防流式结束事件丢失/时序异常时媒体滞留(landInFlightMedia 内部会跳过流式目标楼,
                // 不会误写;非流式楼则直接落地)。超长流式输出期间重试会自然空转,无害。
                if (!isStreamActive) {
                    await landInFlightMedia();
                } else {
                    setTimeout(() => { landInFlightMedia(); }, 10000);
                }

            } catch (error) {
                console.error(`[${extensionName}] Generation failed:`, error);
                if (timer) clearInterval(timer);
                if (toast) toastr.clear(toast);
                toastr.error(`Media generation error: ${error.message || error}`);

                failedPrompts.set(promptHash, error.message || String(error));
                // 上限保护:用户多次失败不重试时防止 Map 无界增长(FIFO 丢最早一条)
                if (failedPrompts.size > 200) {
                    const firstKey = failedPrompts.keys().next().value;
                    failedPrompts.delete(firstKey);
                }
                processingHashes.delete(promptHash);

                // 非流式:走防抖合并,避免 N 张并发失败触发 N 次 updateMessageBlock
                // 流式:等 GENERATION_ENDED 的 requestDebouncedUpdate 兜底(ST 流式期间改 DOM 会被覆盖)
                if (!isStreamActive) {
                    requestDebouncedUpdate(false);
                }
            } finally {
                // 兜底清理
                if (processingHashes.has(promptHash)) {
                    processingHashes.delete(promptHash);
                }
                // 非流式:所有图都完成时持久化一次(saveChat 不防抖,N 张并完成就是 N 次全量聊天写盘)
                if (!isStreamActive && processingHashes.size === 0) {
                    try {
                        const ctx = getContext();
                        await ctx.saveChat();
                    } catch (e) {
                        console.error(`[${extensionName}] saveChat failed:`, e);
                    }
                }
            }
        })();
    }

    // --- 提交更新 ---
    if (!onlyTrigger && contentModified) {
        message.mes = currentMessageText;
        updateMessageBlock(messageIndex, message);
        // 占位符已写入 mes → 预览浮窗跟进刷新
        scheduleMediaPreviewRender();

        // 触发保存
        await eventSource.emit(event_types.MESSAGE_UPDATED, messageIndex);
        if (isFinal) {
            const finalContext = getContext();
            await finalContext.saveChat();
        }
    }
}

/**
 * 切进聊天时全量扫描旧楼层:把裸 [image]/[video] 标签转成占位符(仅手动模式)。
 * processMessageContent 只处理最后一楼,切聊天(CHAT_CHANGED)时中间楼层的裸标签
 * 没有任何事件会处理 → 永远停留在原始文本,连点击生图的入口都看不到。
 * 自动模式不动旧楼层:避免每次进聊天连环触发生成;最新楼层仍走原有事件驱动路径。
 * prompt/参数提取、特征注入、hash 计算与 processMessageContent 逻辑 B-0 保持一致。
 */
async function processAllMessagesForPlaceholders() {
    const s = extension_settings[extensionName];
    if (!s || s.mediaType === 'disabled') return;
    if (s.autoReplace !== 'manual') return; // 仅手动模式

    const context = getContext();
    const chat = context.chat || [];
    const regexStr = s.mediaType === 'image' ? s.imageRegex : s.videoRegex;
    if (!regexStr) return;
    const mediaTagRegex = regexFromString(regexStr);

    const changedFloors = [];
    for (let i = 0; i < chat.length; i++) {
        const message = chat[i];
        if (!message || message.is_user || !message.mes) continue;

        let mes = message.mes;
        let modified = false;

        // 存量自愈:修嵌套占位符 + 属性值裸换行(见 healPlaceholderDamage 注释)
        const healed = healPlaceholderDamage(mes);
        if (healed !== mes) {
            console.warn(`[${extensionName}] 修复占位符存量损伤: 楼${i}`);
            mes = healed;
            modified = true;
        }

        const matches = [...mes.matchAll(mediaTagRegex)];
        if (matches.length === 0) {
            if (modified) { message.mes = mes; updateMessageBlock(i, message); changedFloors.push(i); }
            continue;
        }

        for (const [index, match] of matches.entries()) {
            // 守卫同 processMessageContent:跳过占位符/wrapper 属性里携带的标签文本
            if (isInsideHtmlTag(mes, match.index)) continue;

            const originalTag = match[0];

            let rawPrompt = extractTagPrompt(match);
            if (!rawPrompt) continue;

            // 与逻辑 B-0 一致:用注入角色特征后的 prompt 计算 hash
            const injectionResult = injectCharacterTags(rawPrompt, s.characterTags);
            const promptHash = simpleHash(normalizePrompt(injectionResult.modifiedPrompt));
            const placeholder = buildPlaceholder({
                promptHash,
                index,
                mediaType: s.mediaType,
                rawPrompt,
                originalTag,
                state: 'idle',
            });
            mes = replaceLiteral(mes, originalTag, placeholder);
            modified = true;
        }
        if (modified) {
            message.mes = mes;
            updateMessageBlock(i, message);
            changedFloors.push(i);
        }
    }

    if (changedFloors.length > 0) {
        for (const i of changedFloors) {
            await eventSource.emit(event_types.MESSAGE_UPDATED, i);
        }
        await context.saveChat();
        console.log(`[${extensionName}] 旧楼层裸标签已转占位符: 楼层 ${changedFloors.join(', ')}`);
    }
}

/**
 * 统一 click handler:占位符 + 生成图 wrapper 共用同一个事件委托。
 * 子元素用 [data-mag-role] 路由(toggle/copy/zoom),主体点击走默认动作
 * (占位符 → 触发生成;wrapper → toggle data-revealed)。
 */
async function onMagClick(e) {
    const $el = $(this);
    const $roleEl = $(e.target).closest('[data-mag-role]');
    const role = $roleEl.attr('data-mag-role');

    // --- 子元素角色路由 ---
    if (role === 'toggle' || role === 'prompt-toggle') {
        e.preventDefault();
        e.stopPropagation();
        const cur = $el.attr('data-view');
        $el.attr('data-view', cur === 'default' ? 'prompt' : 'default');
        return;
    }
    if (role === 'copy') {
        e.preventDefault();
        e.stopPropagation();
        const prompt = $el.attr('data-prompt');
        try {
            if (typeof copyText === 'function') {
                await copyText(prompt);
            } else {
                await navigator.clipboard.writeText(prompt);
            }
            toastr.success('已复制 prompt');
        } catch (err) {
            console.error(`[${extensionName}] copy failed:`, err);
            toastr.error('复制失败');
        }
        return;
    }
    if (role === 'zoom') {
        e.preventDefault();
        e.stopPropagation();
        const $media = $el.find('img, video').first();
        const url = $media.attr('src');
        const mediaType = $el.attr('data-media-type');
        const prompt = $el.attr('data-prompt');
        if (url && typeof openGalleryLightbox === 'function') {
            openGalleryLightbox({ url, mediaType, prompt });
        }
        return;
    }
    if (role === 'regenerate') {
        e.preventDefault();
        e.stopPropagation();
        // 仅 mag-media(已生成图) 有此按钮;占位符不挂这个 role
        if ($el.hasClass('mag-media') || $el.hasClass('custom-mag-media')) {
            await regenerateMedia($el);
        }
        return;
    }

    // --- 主体点击(默认动作) ---
    const isPlaceholder = $el.hasClass('mag-placeholder') || $el.hasClass('custom-mag-placeholder');
    const isMedia = $el.hasClass('mag-media') || $el.hasClass('custom-mag-media');

    if (isPlaceholder) {
        e.preventDefault();
        // loading 态点击 = 请求中断(视频生成耗时数分钟,见 requestAbortManualGeneration);idle/error 走触发生成
        if ($el.attr('data-state') === 'loading') {
            if ($el.attr('data-view') !== 'default') return;
            await requestAbortManualGeneration($el);
            return;
        }
        if ($el.attr('data-view') !== 'default') return; // prompt 视图下点主体不触发生成
        await startManualGeneration($el);
    } else if (isMedia) {
        e.preventDefault();
        const cur = $el.attr('data-revealed');
        $el.attr('data-revealed', cur === 'true' ? 'false' : 'true');
    }
}

// 手动模式进行中的生成登记(key: magId):视频生成耗时数分钟,允许用户点击 loading 态
// 占位符 → 确认弹窗 → 中断。value: { controller: AbortController, comfyUrl }
const manualGenerations = new Map();

/**
 * 中断指定 magId 的手动生成:abort 前端请求(排队中的 job 轮到时也会被取消)
 * + 直连 ComfyUI /interrupt 打断后端正在执行的任务(同 LoRA/放大列表直连,要求
 * --enable-cors-header;失败静默降级——最坏情况只是后端把任务跑完丢弃)。
 * 串行队列里排在其后的其他 job 不受影响,继续正常执行。
 */
function abortManualGeneration(magId) {
    const entry = manualGenerations.get(magId);
    if (!entry) return false;
    entry.controller.abort();
    const base = String(entry.comfyUrl || '').trim().replace(/\/+$/, '');
    if (base) {
        fetch(`${base}/interrupt`, { method: 'POST' }).catch(() => { });
    }
    return true;
}

/** loading 态占位符点击 → 确认弹窗 → 确认后中断生成 */
async function requestAbortManualGeneration($ph) {
    const magId = $ph.attr('data-mag-id');
    if (!manualGenerations.has(magId)) {
        // 登记不存在:生成刚好结束(成功落地/已完成 catch),或非本插件发起的 loading 态
        toastr.info('该生成任务已结束或不可中断');
        return;
    }
    const mediaTypeText = $ph.attr('data-media-type') === 'video' ? '视频' : '图片';
    const result = await callGenericPopup(
        `确认终止本次${mediaTypeText}生成?已进行的进度将丢弃。`,
        POPUP_TYPE.CONFIRM,
        '',
        { okButton: '终止生成', cancelButton: '继续等待' },
    );
    if (result !== POPUP_RESULT.AFFIRMATIVE) return;
    if (!abortManualGeneration(magId)) {
        // 弹窗期间生成恰好自然结束:无事发生,占位符已被正常落地/置错
        toastr.info('生成已完成,无需终止');
    }
}

/**
 * 手动模式占位符 → 触发 ComfyUI 生成 → 替换为 mag-media wrapper。
 * 从原 onPlaceholderClick 抽出来,统一 click handler 调用。
 */
async function startManualGeneration($ph) {
    const magId = $ph.attr('data-mag-id');
    const rawPrompt = $ph.attr('data-prompt');
    const mediaType = $ph.attr('data-media-type');

    $ph.attr('data-state', 'loading');
    $ph.find('[data-mag-role="icon"]').attr('class', 'fa-solid fa-circle-notch fa-spin');

    // 登记可中断句柄:loading 态点击占位符 → 确认弹窗 → abort(见 requestAbortManualGeneration)
    const abortController = new AbortController();
    manualGenerations.set(magId, { controller: abortController, comfyUrl: getActiveComfyUrl() });

    // 注入角色特征 → 与自动模式一致地计算 hash
    const injectionResult = injectCharacterTags(rawPrompt, extension_settings[extensionName].characterTags);
    const modifiedPrompt = injectionResult.modifiedPrompt;
    const promptHash = simpleHash(normalizePrompt(modifiedPrompt));

    let timer = null;
    let seconds = 0;
    let toast = null;

    try {
        const mediaTypeText = mediaType === 'image' ? '图片' : '视频';
        const baseText = `⏳ 生成${mediaTypeText}...`;
        toast = toastr.info(`${baseText} 0s`, '', { timeOut: 0, extendedTimeOut: 0, closeButton: true });
        timer = setInterval(() => {
            seconds++;
            if (toast && toast.find) {
                toast.find('.toast-message').text(`${baseText} ${seconds}s`);
            }
        }, 1000);

        const { url, format, character, finalPrompt } = await generateViaComfy(modifiedPrompt, mediaType, null, false, abortController.signal);
        clearInterval(timer);
        if (toast) toastr.clear(toast);

        const mediaWrap = buildMediaWrap({ magId, mediaType, url, rawPrompt });

        failedPrompts.delete(promptHash);
        pushGalleryEntry({ url, character, prompt: finalPrompt, mediaType, format });

        // 按 magId 反查真实消息并替换(占位符可能在旧楼层,非最后一条),成功才提示
        const committed = await commitMediaToMessage(magId, mediaWrap, 'startManualGeneration');
        if (committed) toastr.success(`替换完成: 1 张${mediaTypeText}`);
    } catch (err) {
        if (timer) clearInterval(timer);
        if (toast) toastr.clear(toast);

        // 用户主动中断 ≠ 失败:占位符恢复 idle 态,可再次点击重新生成
        if (abortController.signal.aborted) {
            toastr.info(`已终止${mediaType === 'image' ? '图片' : '视频'}生成`);
            $ph.attr('data-state', 'idle');
            $ph.attr('data-error', '');
            $ph.find('[data-mag-role="icon"]').attr('class', `fa-solid ${mediaType === 'video' ? 'fa-video' : 'fa-image'}`);
            $ph.find('[data-mag-role="label"]').text(mediaType === 'video' ? '生成视频' : '生成图片');
            const promptText = rawPrompt.length > 200 ? rawPrompt.slice(0, 200) + '...' : rawPrompt;
            $ph.find('[data-mag-role="prompt-text"]').text(promptText);
            return;
        }

        console.error(`[${extensionName}] Manual generation failed:`, err);
        toastr.error(`Media generation error: ${err.message || err}`);
        const errMsg = err.message || String(err);
        $ph.attr('data-state', 'error');
        $ph.attr('data-view', 'default'); // 失败时强制收起 prompt 视图,确保错误信息在 default 视图下可见
        $ph.attr('data-error', errMsg);
        $ph.find('[data-mag-role="icon"]').attr('class', 'fa-solid fa-triangle-exclamation');
        $ph.find('[data-mag-role="label"]').text('点击重试');
        $ph.find('[data-mag-role="prompt-text"]').text('⚠️ ' + errMsg.slice(0, 200));
    } finally {
        manualGenerations.delete(magId);
    }
}

/**
 * 已生成的 mag-media wrapper → 重新调一次 ComfyUI 生成。
 * 与 startManualGeneration 的区别:入口是已生成图(不是占位符),每次都走 generateViaComfy
 * (该函数内部 getActivePreset() 实时读最新 ComfyUI 配置档,所以改完配置立即生效)。
 * 不走 promptHistory 冷却检查(冷却只拦自动触发,手动重生成不拦)。
 */
async function regenerateMedia($media) {
    const magId = $media.attr('data-mag-id');
    const rawPrompt = $media.attr('data-prompt');
    const mediaType = $media.attr('data-media-type');

    // 注入角色特征,与 startManualGeneration 一致地计算 hash(用于 processingHashes 锁 + failedPrompts 失败降级)
    const injectionResult = injectCharacterTags(rawPrompt, extension_settings[extensionName].characterTags);
    const modifiedPrompt = injectionResult.modifiedPrompt;
    const promptHash = simpleHash(normalizePrompt(modifiedPrompt));

    if (processingHashes.has(promptHash)) {
        toastr.info('该 prompt 正在生成中,请稍候');
        return;
    }
    processingHashes.add(promptHash);

    $media.attr('data-regenerating', 'true');
    let timer = null;
    let seconds = 0;
    let toast = null;
    try {
        const mediaTypeText = mediaType === 'image' ? '图片' : '视频';
        const baseText = `⏳ 重新生成${mediaTypeText}...`;
        toast = toastr.info(`${baseText} 0s`, '', { timeOut: 0, extendedTimeOut: 0, closeButton: true });
        timer = setInterval(() => {
            seconds++;
            if (toast && toast.find) toast.find('.toast-message').text(`${baseText} ${seconds}s`);
        }, 1000);

        const { url, format, character, finalPrompt } = await generateViaComfy(modifiedPrompt, mediaType);
        clearInterval(timer);
        if (toast) toastr.clear(toast);

        // 构造新 wrapper(同 magId,replacePlaceholderInMes 用 magId 锚定替换 mes 里的旧 wrapper)
        const mediaWrap = buildMediaWrap({ magId, mediaType, url, rawPrompt });

        failedPrompts.delete(promptHash);
        pushGalleryEntry({ url, character, prompt: finalPrompt, mediaType, format });

        // 按 magId 反查真实消息并替换(wrapper 可能在旧楼层),成功才提示
        const committed = await commitMediaToMessage(magId, mediaWrap, 'regenerateMedia');
        if (committed) toastr.success(`已重新生成: 1 张${mediaTypeText}`);
    } catch (err) {
        console.error(`[${extensionName}] Regenerate failed:`, err);
        if (timer) clearInterval(timer);
        if (toast) toastr.clear(toast);
        toastr.error(`重新生成失败: ${err.message || err}`);
    } finally {
        $media.removeAttr('data-regenerating');
        processingHashes.delete(promptHash);
    }
}

/**
 * 构造 mag-placeholder span HTML(idle/error 两态共享结构)。
 * 占位符:块级卡片,5 个 data-mag-role 子元素(icon/label/prompt-text/copy/toggle)。
 * 子元素用 <i>/<small> 而非 <span>(replacePlaceholderInMes 正则靠外层 </span> 闭合,内层不许嵌套 span)。
 * 用 data-mag-role 属性锚定样式/事件,绕开 ST sanitizer 的 custom- 前缀。
 * 自动模式失败降级(error 态)和手动模式 idle 占位符共用此函数。
 */
function buildPlaceholder({ promptHash, index, mediaType, rawPrompt, originalTag, state, error }) {
    const magId = `${promptHash}-${index}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const phClass = mediaType === 'video' ? 'mag-ph-video' : 'mag-ph-image';
    let iconClass, labelText, promptText;
    if (state === 'error') {
        iconClass = 'fa-triangle-exclamation';
        labelText = '点击重试';
        promptText = '⚠️ ' + (error || '生成失败').slice(0, 200);
    } else {
        iconClass = mediaType === 'video' ? 'fa-video' : 'fa-image';
        labelText = mediaType === 'video' ? '生成视频' : '生成图片';
        promptText = rawPrompt.length > 200 ? rawPrompt.slice(0, 200) + '...' : rawPrompt;
    }
    const errorAttr = state === 'error' ? ` data-error="${escapeHtmlAttribute(error || '')}"` : '';
    return `<span class="mag-placeholder ${phClass}" data-mag-id="${escapeHtmlAttribute(magId)}" data-state="${state}" data-view="default" data-prompt="${escapeHtmlAttribute(rawPrompt)}" data-media-type="${mediaType}" data-original-tag="${escapeHtmlAttribute(originalTag)}"${errorAttr} contenteditable="false"><i class="fa-solid ${iconClass}" data-mag-role="icon"></i><small data-mag-role="label">${labelText}</small><small data-mag-role="prompt-text">${escapeHtmlAttribute(promptText)}</small><i class="fa-solid fa-copy" data-mag-role="copy"></i><small data-mag-role="toggle">prompt描述</small></span>`;
}

/**
 * 构造 mag-media wrapper HTML(包 img/video + 4 个 data-mag-role 子元素)。
 * 占位符替换 / 自动模式生成 共用此函数,保证产物结构一致。
 */
function buildMediaWrap({ magId, mediaType, url, rawPrompt }) {
    const style = extension_settings[extensionName].style || '';
    const escapedUrl = escapeHtmlAttribute(url);
    const escapedPrompt = escapeHtmlAttribute(rawPrompt);
    const promptText = rawPrompt.length > 200 ? rawPrompt.slice(0, 200) + '...' : rawPrompt;
    const escapedPromptText = escapeHtmlAttribute(promptText);

    const mediaInner = mediaType === 'video'
        ? `<video src="${escapedUrl}" prompt="${escapedPrompt}" style="${style}" loop controls autoplay muted/>`
        : `<img src="${escapedUrl}" prompt="${escapedPrompt}" style="${style}" />`;

    return `<span class="mag-media" data-mag-id="${escapeHtmlAttribute(magId)}" data-media-type="${mediaType}" data-prompt="${escapedPrompt}" data-revealed="false" data-view="default" contenteditable="false">${mediaInner}<small data-mag-role="prompt-text">${escapedPromptText}</small><i class="fa-solid fa-copy" data-mag-role="copy"></i><small data-mag-role="prompt-toggle">prompt描述</small><small data-mag-role="regenerate">重新生成</small><small data-mag-role="zoom">放大</small></span>`;
}

// 全局事件委托 — 抗 ST 重渲/切聊天,只在 document 上绑一次
// 用 data-mag-id 属性锚定(ST sanitizer 会给 class 加 custom- 前缀,不能用 class 选择器)
$(document).on('click.magph', '[data-mag-id]', onMagClick);

// --- Gallery 图库 ---

let galleryRenderPending = false;
let galleryRenderSig = null;

/** 把一次生成成功的结果追加到 manifest 并刷新 UI */
function pushGalleryEntry(entry) {
    const s = extension_settings[extensionName];
    if (!Array.isArray(s.galleryManifest)) s.galleryManifest = [];
    s.galleryManifest.push({ ...entry, timestamp: Date.now() });
    saveSettingsDebounced();
    scheduleGalleryRender();
    scheduleMediaPreviewRender(); // 生成成功即时出现到预览浮窗(流式中走 in-flight)
}

/** 合并同一帧内的多次 push,避免批量生成时连续 rebuild */
function scheduleGalleryRender() {
    if (galleryRenderPending) return;
    galleryRenderPending = true;
    requestAnimationFrame(() => {
        galleryRenderPending = false;
        renderGallery();
    });
}

/** 释放 video 元素持有的媒体资源 */
function releaseVideoEl($video) {
    $video.each(function () {
        this.pause();
        this.removeAttribute('src');
        this.load();
    });
}

/** 懒创建 lightbox DOM 并绑定全局关闭事件(只执行一次) */
function ensureGalleryLightbox() {
    if ($('#mag_gallery_lightbox').length) return;
    $('body').append(`
        <div id="mag_gallery_lightbox">
            <div class="lightbox-close" title="Close" data-i18n="[title]mag_gallery_close">
                <i class="fa-solid fa-xmark"></i>
            </div>
            <div class="lightbox-stage">
                <img class="lightbox-media" alt="" />
                <video class="lightbox-media" controls loop autoplay muted style="display:none;"></video>
                <div class="lightbox-prompt">
                    <div class="lightbox-prompt-text"></div>
                    <button class="lightbox-copy-btn" title="复制提示词" data-i18n="[title]mag_gallery_copy">
                        <i class="fa-solid fa-copy"></i>
                    </button>
                </div>
            </div>
        </div>
    `);
    const $lb = $('#mag_gallery_lightbox');
    $lb.find('.lightbox-close').on('click', closeGalleryLightbox);
    // 点 prompt 区域(文字 + 复制按钮)不关闭,允许选中文字 / 点按钮;其余任意位置都关闭
    $lb.on('click', (e) => {
        if ($(e.target).closest('.lightbox-prompt').length) return;
        closeGalleryLightbox();
    });
    $(document).on('keydown.galleryLightbox', (e) => {
        if (e.key === 'Escape') closeGalleryLightbox();
    });
    $lb.find('.lightbox-copy-btn').on('click', async () => {
        const text = $lb.find('.lightbox-copy-btn').data('prompt') || '';
        if (!text) { toastr.warning('提示词为空'); return; }
        try {
            await copyText(text);
            toastr.success('已复制提示词');
        } catch (err) {
            toastr.error('复制失败,请手动选择文本');
        }
    });
}

/** 打开 lightbox 显示指定 entry */
function openGalleryLightbox(entry) {
    ensureGalleryLightbox();
    const $lb = $('#mag_gallery_lightbox');
    const $img = $lb.find('img.lightbox-media');
    const $video = $lb.find('video.lightbox-media');

    if (entry.mediaType === 'video') {
        $img.css('display', 'none').attr('src', '');
        $video.css('display', 'block').attr('src', entry.url);
    } else {
        releaseVideoEl($video.css('display', 'none'));
        $img.css('display', 'block').attr('src', entry.url);
    }
    const promptText = entry.prompt || '';
    $lb.find('.lightbox-prompt-text').text(promptText);
    $lb.find('.lightbox-copy-btn').data('prompt', promptText);
    $lb.addClass('open');
}

/** 关闭 lightbox,释放 video 资源 */
function closeGalleryLightbox() {
    const $lb = $('#mag_gallery_lightbox');
    if (!$lb.length || !$lb.hasClass('open')) return;
    $lb.removeClass('open');
    releaseVideoEl($lb.find('video.lightbox-media'));
}

/** 渲染 gallery panel:角色分类方块(3 列),点击方块弹窗显示该角色所有图 */
function renderGallery() {
    const $container = $('#gallery_container');
    const $empty = $('#gallery_empty');
    if (!$container.length) return;

    const manifest = extension_settings[extensionName].galleryManifest || [];

    // 同一 manifest 状态不重复 render(updateUI 频繁触发时跳过)
    const sig = manifest.length + ':' + (manifest[manifest.length - 1]?.timestamp || 0);
    if (sig === galleryRenderSig && manifest.length > 0) return;
    galleryRenderSig = sig;

    if (manifest.length === 0) {
        $container.empty();
        $empty.css('display', 'flex');
        return;
    }
    $empty.css('display', 'none');

    // 按角色分组;组内/组间均按 timestamp 倒序
    const groups = new Map();
    for (let i = 0; i < manifest.length; i++) {
        const entry = manifest[i];
        const key = entry.character || 'media';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push({ entry, index: i });
    }
    for (const arr of groups.values()) {
        arr.sort((a, b) => (b.entry.timestamp || 0) - (a.entry.timestamp || 0));
    }
    const sortedGroups = [...groups.entries()].sort((a, b) => {
        const aMax = a[1][0]?.entry.timestamp || 0;
        const bMax = b[1][0]?.entry.timestamp || 0;
        return bMax - aMax;
    });

    $container.empty();
    sortedGroups.forEach(([charName, items]) => {
        // 代表图:组内最新一张
        const avatarEntry = items[0].entry;
        const avatarUrl = escapeHtmlAttribute(avatarEntry.url);
        const avatarIsVideo = avatarEntry.mediaType === 'video' || VIDEO_FORMATS.has(avatarEntry.format);
        const avatarTag = avatarIsVideo
            ? `<video class="gallery-tile-img" src="${avatarUrl}" muted preload="metadata" playsinline></video>`
            : `<img class="gallery-tile-img" src="${avatarUrl}" loading="lazy" />`;
        const videoBadge = avatarIsVideo ? `<div class="gallery-tile-video-badge"><i class="fa-solid fa-play"></i></div>` : '';
        const escapedName = escapeHtmlAttribute(charName);
        $container.append(`
            <div class="gallery-tile" data-char="${escapedName}">
                <div class="gallery-tile-img-wrap">${avatarTag}${videoBadge}<div class="gallery-tile-count">${items.length}</div></div>
                <div class="gallery-tile-name" title="${escapedName}">${escapedName}</div>
            </div>
        `);
    });
}

/** 绑定 gallery 事件:角色方块点击 → 弹该角色图集 modal;modal 内缩略图点击 → 单图 lightbox */
function bindGalleryEvents() {
    ensureGalleryLightbox();
    ensureGroupModal();
    // 点角色方块 → 打开该角色的图集 modal
    $('#gallery_container').off('click.galleryTile').on('click.galleryTile', '.gallery-tile', function () {
        const charName = $(this).attr('data-char');
        const manifest = extension_settings[extensionName].galleryManifest || [];
        const items = [];
        manifest.forEach((entry, index) => {
            const key = entry.character || 'media';
            if (key === charName) items.push({ entry, index });
        });
        if (items.length === 0) return;
        items.sort((a, b) => (b.entry.timestamp || 0) - (a.entry.timestamp || 0));
        openGroupModal(charName, items);
    });
    // modal 内缩略图点击 → 单图 lightbox
    $('#mag_gallery_group_modal').off('click.groupThumb').on('click.groupThumb', '.group-modal-thumb-wrap', function () {
        const idx = parseInt($(this).attr('data-index'), 10);
        const manifest = extension_settings[extensionName].galleryManifest || [];
        const entry = manifest[idx];
        if (entry) openGalleryLightbox(entry);
    });
}

/** 懒加载角色图集 modal(挂在 body 下) */
function ensureGroupModal() {
    if ($('#mag_gallery_group_modal').length) return;
    $('body').append(`
        <div id="mag_gallery_group_modal">
            <div class="group-modal-header">
                <span class="group-modal-title"></span>
                <div class="group-modal-close" title="关闭" data-i18n="[title]mag_gallery_close">
                    <i class="fa-solid fa-xmark"></i>
                </div>
            </div>
            <div class="group-modal-body">
                <div class="group-modal-grid"></div>
            </div>
        </div>
    `);
    const $m = $('#mag_gallery_group_modal');
    $m.find('.group-modal-close').on('click', closeGroupModal);
    // 点 header/body 之外的暗色背景区也关闭
    $m.on('click', (e) => {
        // 点缩略图(有自己的 handler 打开 lightbox)和关闭按钮不处理
        if ($(e.target).closest('.group-modal-thumb-wrap').length) return;
        if ($(e.target).closest('.group-modal-close').length) return;
        closeGroupModal();
    });
    $(document).on('keydown.groupModal', (e) => {
        // lightbox 开着时 ESC 优先关 lightbox,不关 modal
        if (e.key === 'Escape' && $m.hasClass('open') && !$('#mag_gallery_lightbox').hasClass('open')) {
            closeGroupModal();
        }
    });
}

/** 打开角色图集 modal:渲染该角色所有图到网格 */
function openGroupModal(charName, items) {
    ensureGroupModal();
    const $m = $('#mag_gallery_group_modal');
    $m.find('.group-modal-title').text(`${charName} · ${items.length} 张`);
    const $grid = $m.find('.group-modal-grid');
    $grid.empty();
    for (const { entry, index } of items) {
        const escapedUrl = escapeHtmlAttribute(entry.url);
        const isVideo = entry.mediaType === 'video' || VIDEO_FORMATS.has(entry.format);
        const badge = isVideo ? `<div class="group-modal-video-badge"><i class="fa-solid fa-play"></i></div>` : '';
        const tag = isVideo
            ? `<video class="group-modal-thumb" src="${escapedUrl}" muted preload="metadata" playsinline></video>`
            : `<img class="group-modal-thumb" src="${escapedUrl}" loading="lazy" />`;
        const timeStr = formatGalleryTime(entry.timestamp);
        $grid.append(`
            <div class="group-modal-thumb-wrap" data-index="${index}">${tag}${badge}<div class="group-modal-thumb-time">${timeStr}</div></div>
        `);
    }
    $m.addClass('open');
    $m.scrollTop(0);
}

/** 关闭角色图集 modal(释放视频资源) */
function closeGroupModal() {
    const $m = $('#mag_gallery_group_modal');
    $m.removeClass('open');
    $m.find('video').each(function () { releaseVideoEl($(this)); });
    $m.find('.group-modal-grid').empty();
}

// --- 媒体预览浮窗(按楼层) ---
// 流式期间 ST 持续重写消息 DOM,替换进去的图片会被还原,流式结束才可见(ST 固有行为)。
// 本浮窗独立于消息 DOM:直接扫 context.chat 各楼层 mes + 流式暂存 inFlightMedia,生成中即可看图。

let mediaPreviewRenderPending = false;

/** escapeHtmlAttribute 的逆变换:解码从 mes 扫出来的属性值 */
function unescapeHtmlAttr(v) {
    return v.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#13;/g, '\r').replace(/&#10;/g, '\n').replace(/&amp;/g, '&');
}

/** 从 HTML 片段里取 name="..." 属性值(返回原始转义值;容忍属性名与 = 间的空白,与 MAG_MEDIA_WRAP_RE 同风格) */
function extractAttr(html, name) {
    const m = html.match(new RegExp('\\b' + name + '\\s*=\\s*"([^"]*)"'));
    return m ? m[1] : '';
}

/** 把 mag-media wrapper 块解析成 {ts,url,mediaType,prompt,magId};无 src 返回 null。mediaType 以内层标签名为准 */
function parseMediaWrapper(block) {
    // lazy [^>]*?:buildMediaWrap 产物里 src 紧跟标签名,避免贪婪回溯扫过整个 base64
    const srcMatch = block.match(/<(img|video)\b[^>]*?\ssrc="([^"]*)"/);
    if (!srcMatch) return null;
    // magId 格式 `${promptHash}-${index}-${ts36}-${rand}`,base36 创建时间戳在倒数第二段
    const parts = extractAttr(block, 'data-mag-id').split('-');
    const ts = parts.length >= 3 ? parseInt(parts[parts.length - 2], 36) : 0;
    return {
        ts: Number.isFinite(ts) ? ts : 0,
        url: unescapeHtmlAttr(srcMatch[2]),
        mediaType: srcMatch[1] === 'video' ? 'video' : 'image',
        prompt: unescapeHtmlAttr(extractAttr(block, 'data-prompt')),
        magId: unescapeHtmlAttr(extractAttr(block, 'data-mag-id')),
    };
}

/**
 * 取位置 pos 处媒体标签前紧邻的 <pic_Declare> 描述。
 * AI 输出惯例:declare 块包着图片描述,紧贴 [image]/[video] 标签(中间只隔空白/换行);
 * 隔着其他内容或没有 declare 则返回 null(不关联)。
 */
function declareForPosition(declares, text, pos) {
    for (let j = declares.length - 1; j >= 0; j--) {
        const d = declares[j];
        if (d.index + d[0].length > pos) continue;
        // 只认最近的 declare:它与媒体之间必须全是空白,再往前的更不可能关联
        const gap = text.slice(d.index + d[0].length, pos);
        return /^\s*$/.test(gap) ? d[1].trim() : null;
    }
    return null;
}

/**
 * 收集当前聊天各楼层的媒体记录:楼层降序,同楼层按创建时间(ts)升序。
 * 字段:{ floor, ts, url, mediaType, prompt, declare }
 * 来源:① mes 里持久化的 mag-media wrapper ② 旧格式裸 <img|video prompt=...>(wrapper 重构前)
 *      ③ 流式期间未落地的 inFlightMedia(归属最新楼层,落地后被消费转入 ①;declare 为触发时刻捕获的快照)
 */
function collectFloorMedia() {
    const chat = getContext().chat || [];
    const records = [];
    const tagRe = /<(img|video)\b[^>]*>/g;

    for (let i = 0; i < chat.length; i++) {
        const mes = chat[i]?.mes;
        if (typeof mes !== 'string' || !mes.includes('<')) continue;

        // declare 块一次扫齐(带位置),供各媒体按位置反查紧邻的描述
        const declares = [...mes.matchAll(PIC_DECLARE_RE)];

        // ① wrapper
        let hasWrapper = false;
        MAG_MEDIA_WRAP_RE.lastIndex = 0;
        let wm;
        while ((wm = MAG_MEDIA_WRAP_RE.exec(mes)) !== null) {
            hasWrapper = true;
            const parsed = parseMediaWrapper(wm[0]);
            if (parsed) records.push({ floor: i, declare: declareForPosition(declares, mes, wm.index), ...parsed });
        }

        // ② 旧格式:先剥掉 wrapper 再扫(wrapper 的 src 是 MB 级 base64,直接扫整个 mes 会空耗一遍),
        //    剩余部分里找带 prompt 属性的裸 img/video(declare 在 wrapper 外,剥掉后仍保留)
        const bare = hasWrapper ? mes.replace(MAG_MEDIA_WRAP_RE, '') : mes;
        const bareDeclares = hasWrapper ? [...bare.matchAll(PIC_DECLARE_RE)] : declares;
        tagRe.lastIndex = 0;
        let tm;
        while ((tm = tagRe.exec(bare)) !== null) {
            if (!tm[0].includes('prompt="')) continue;
            const srcMatch = tm[0].match(/\ssrc="([^"]*)"/);
            if (!srcMatch) continue;
            records.push({
                floor: i,
                ts: 0, // 旧格式无创建时间,视为最旧
                url: unescapeHtmlAttr(srcMatch[1]),
                mediaType: tm[1] === 'video' ? 'video' : 'image',
                prompt: unescapeHtmlAttr(extractAttr(tm[0], 'prompt')),
                declare: declareForPosition(bareDeclares, bare, tm.index),
            });
        }
    }

    // ③ 流式暂存,归属最新楼层(declare 为触发生成时捕获的快照,落地后转入 ①)
    if (chat.length > 0) {
        const floor = chat.length - 1;
        for (const entry of inFlightMedia.values()) {
            const parsed = parseMediaWrapper(entry.mediaTag);
            if (parsed) records.push({ floor, declare: entry.declare ?? null, inFlight: true, ...parsed });
        }
    }

    records.sort((a, b) => b.floor - a.floor || (a.ts || 0) - (b.ts || 0));
    return records;
}

/** 懒挂媒体预览 modal 到 body(居中对话框 + 暗色遮罩) */
function ensureMediaPreviewModal() {
    if ($('#mag_media_preview_modal').length) return;
    $('body').append(`
        <div id="mag_media_preview_modal">
            <div class="preview-modal-dialog">
                <div class="preview-modal-header">
                    <span class="preview-modal-title" data-i18n="mag_media_preview_title">媒体预览</span>
                    <div class="preview-modal-close" title="关闭" data-i18n="[title]mag_media_preview_close">
                        <i class="fa-solid fa-xmark"></i>
                    </div>
                </div>
                <div class="preview-modal-body"></div>
            </div>
        </div>
    `);
    const $m = $('#mag_media_preview_modal');
    $m.find('.preview-modal-close').on('click', closeMediaPreviewModal);
    // 点暗色遮罩关闭(对话框内的点击不关)
    $m.on('click', (e) => {
        if ($(e.target).closest('.preview-modal-dialog').length) return;
        closeMediaPreviewModal();
    });
    $(document).on('keydown.mediaPreview', (e) => {
        // lightbox 开着时 ESC 优先关 lightbox,不关本浮窗
        if (e.key === 'Escape' && $m.hasClass('open') && !$('#mag_gallery_lightbox').hasClass('open')) {
            closeMediaPreviewModal();
        }
    });
    // 点媒体本体(img/video)→ 放大;declare/时间文字区域不放大
    // (复用 gallery lightbox,entry 字段与 openGalleryLightbox 一致)
    $m.find('.preview-modal-body').on('click', '.preview-media-row img, .preview-media-row video', function () {
        const $row = $(this).closest('.preview-media-row');
        openGalleryLightbox({
            url: $row.attr('data-url'),
            mediaType: $row.attr('data-media-type'),
            prompt: $row.attr('data-prompt'),
        });
    });
    // 点楼层分隔行的重生按钮 → 整楼层媒体重新生成(body 内容会被重渲,委托抗重渲)
    $m.find('.preview-modal-body').on('click', '.preview-floor-regen-btn', async function (e) {
        e.preventDefault();
        e.stopPropagation();
        await regenerateFloorMedia(Number($(this).closest('.preview-floor-sep').attr('data-floor')));
    });
}

/** 渲染浮窗内容(仅 open 状态执行;重建时保留滚动位置) */
function renderMediaPreviewModal() {
    const $m = $('#mag_media_preview_modal');
    if (!$m.length || !$m.hasClass('open')) return;

    const latestFloor = (getContext().chat || []).length - 1;
    const records = collectFloorMedia();
    const $body = $m.find('.preview-modal-body');

    releaseVideoEl($body.find('video'));
    const scrollTop = $body[0].scrollTop;
    $body.empty();

    if (records.length === 0) {
        $body.append(`<div class="preview-modal-empty" data-i18n="mag_media_preview_empty">当前聊天暂无生成媒体</div>`);
        return;
    }

    // 创建时间优先取图库 manifest(生成完成时刻,最准);没有再退回 magId 时间戳(占位符创建时刻)
    const manifest = extension_settings[extensionName].galleryManifest || [];
    const manifestTs = new Map();
    for (const e of manifest) {
        if (e?.url) manifestTs.set(e.url, e.timestamp || 0);
    }

    let currentFloor = null;
    let floorSeq = 0; // 楼内序号:层内按创建时间正序,即展示顺序编号
    for (const r of records) {
        if (r.floor !== currentFloor) {
            currentFloor = r.floor;
            floorSeq = 0;
            const labelText = r.floor === latestFloor ? '最新' : `第 ${r.floor} 楼的图片`;
            // 楼层重生按钮:busy 时转圈 + 禁用(重渲由 floorRegenBusy 驱动,落地触发的刷新也能保持禁用态)
            const busy = floorRegenBusy.has(r.floor);
            const btnIcon = busy ? 'fa-circle-notch fa-spin busy' : 'fa-rotate-right';
            $body.append(`
                <div class="preview-floor-sep" data-floor="${r.floor}"><span class="preview-floor-label">${labelText}</span><div class="preview-floor-line"></div><i class="fa-solid ${btnIcon} preview-floor-regen-btn" title="重新生成本楼层全部媒体"></i></div>
            `);
        }
        floorSeq++;
        const escapedUrl = escapeHtmlAttribute(r.url);
        const declareHtml = r.declare ? `<div class="preview-media-declare">${escapeHtmlAttribute(r.declare)}</div>` : '';
        const timeTs = manifestTs.get(r.url) || r.ts || 0;
        const timeHtml = `<div class="preview-media-time"><span class="preview-media-seq">第 ${floorSeq} 张</span>${timeTs > 0 ? ` · <span class="preview-media-timestamp">${formatGalleryTime(timeTs)}</span>` : ''}</div>`;
        const mediaTag = r.mediaType === 'video'
            ? `<video src="${escapedUrl}" preload="metadata" controls muted playsinline></video>`
            : `<img src="${escapedUrl}" loading="lazy" />`;
        $body.append(`
            <div class="preview-media-row" data-url="${escapedUrl}" data-media-type="${r.mediaType}" data-prompt="${escapeHtmlAttribute(r.prompt)}">${declareHtml}${mediaTag}${timeHtml}</div>
        `);
    }
    $body[0].scrollTop = scrollTop;
}

/** 合并同一帧内的多次刷新请求 */
function scheduleMediaPreviewRender() {
    if (mediaPreviewRenderPending) return;
    mediaPreviewRenderPending = true;
    requestAnimationFrame(() => {
        mediaPreviewRenderPending = false;
        renderMediaPreviewModal();
    });
}

function openMediaPreviewModal() {
    ensureMediaPreviewModal();
    $('#mag_media_preview_modal').addClass('open');
    renderMediaPreviewModal();
}

function closeMediaPreviewModal() {
    const $m = $('#mag_media_preview_modal');
    if (!$m.length || !$m.hasClass('open')) return;
    $m.removeClass('open');
    releaseVideoEl($m.find('video'));
    $m.find('.preview-modal-body').empty();
}

/**
 * 把楼层 mes 里的旧格式裸 <img|video> 标签(按 url 锚定第一个匹配)替换为新 wrapper 并重渲。
 * 旧格式没有 magId,不能走 replacePlaceholderInMes;扫描前先剥 wrapper(与 collectFloorMedia 同款,
 * 避免 wrapper 的 MB 级 base64 空扫一遍)。收尾与 commitMediaToMessage 一致。
 * @returns {Promise<boolean>} 是否成功定位并替换
 */
async function commitBareMediaToMessage(floor, oldUrl, mediaWrap, callerName) {
    const context = getContext();
    const message = context.chat?.[floor];
    if (!message || typeof message.mes !== 'string') {
        console.warn(`[${extensionName}] ${callerName}: 楼层 ${floor} 不存在,跳过裸标签替换`);
        return false;
    }
    const bare = message.mes.replace(MAG_MEDIA_WRAP_RE, '');
    const tagRe = /<(img|video)\b[^>]*>/g;
    let replaced = false;
    let tm;
    while ((tm = tagRe.exec(bare)) !== null) {
        if (!tm[0].includes('prompt="')) continue;
        const srcMatch = tm[0].match(/\ssrc="([^"]*)"/);
        if (!srcMatch || unescapeHtmlAttr(srcMatch[1]) !== oldUrl) continue;
        // 函数形式替换:mediaWrap 里的 $&/$' 等序列不会被当替换模式解释
        message.mes = message.mes.replace(tm[0], () => mediaWrap);
        replaced = true;
        break;
    }
    if (!replaced) {
        console.warn(`[${extensionName}] ${callerName}: 楼层 ${floor} 未找到 src 匹配的裸标签(oldUrl=${String(oldUrl).slice(0, 80)}),跳过`);
        return false;
    }
    updateMessageBlock(floor, message);
    await eventSource.emit(event_types.MESSAGE_UPDATED, floor);
    await context.saveChat();
    scheduleMediaPreviewRender();
    return true;
}

// 楼层级重新生成进行中的楼层号(renderMediaPreviewModal 据此渲染按钮禁用态)
const floorRegenBusy = new Set();

/**
 * 楼层级重新生成(媒体预览浮窗按钮入口):把指定楼层全部已落地媒体逐张重新生成并原位替换。
 * 与单张 regenerateMedia 的区别:① 批量顺序执行(ComfyUI 后端本就串行,enqueueComfyJob 全局队列)
 * ② 强制随机 seed(固定 seed 下重生结果与旧图几乎相同,楼层重生失去意义) ③ 绕过 promptHistory
 * 冷却(显式用户操作)。in-flight 媒体跳过(尚在生成,mes 里没有可替换锚点);单张失败不中断后续。
 */
async function regenerateFloorMedia(floor) {
    if (!Number.isInteger(floor) || floor < 0) return;
    if (floorRegenBusy.has(floor)) return;

    const records = collectFloorMedia().filter(r => r.floor === floor && !r.inFlight);
    if (records.length === 0) {
        toastr.info('该楼层没有可重新生成的媒体');
        return;
    }

    floorRegenBusy.add(floor);
    scheduleMediaPreviewRender(); // 重渲出按钮禁用态

    let timer = null;
    let seconds = 0;
    let toast = null;
    const total = records.length;
    let ok = 0;
    let fail = 0;
    const progressText = () => `⏳ 重新生成第 ${floor} 楼媒体 ${ok + fail}/${total}...`;

    try {
        toast = toastr.info(`${progressText()} 0s`, '', { timeOut: 0, extendedTimeOut: 0, closeButton: true });
        timer = setInterval(() => {
            seconds++;
            if (toast && toast.find) toast.find('.toast-message').text(`${progressText()} ${seconds}s`);
        }, 1000);

        for (const [i, r] of records.entries()) {
            const injectionResult = injectCharacterTags(r.prompt, extension_settings[extensionName].characterTags);
            const promptHash = simpleHash(normalizePrompt(injectionResult.modifiedPrompt));
            if (processingHashes.has(promptHash)) {
                fail++; // 该 prompt 正被其他流程生成,本轮跳过
                continue;
            }
            processingHashes.add(promptHash);
            try {
                const { url, format, character, finalPrompt } = await generateViaComfy(injectionResult.modifiedPrompt, r.mediaType, null, true);
                // 旧格式裸标签没有 magId,合成一个(buildPlaceholder 同款格式,时间戳可供预览排序)
                const mediaWrap = buildMediaWrap({
                    magId: r.magId || `${promptHash}-${i}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
                    mediaType: r.mediaType,
                    url,
                    rawPrompt: r.prompt,
                });
                const committed = r.magId
                    ? await commitMediaToMessage(r.magId, mediaWrap, 'regenerateFloorMedia')
                    : await commitBareMediaToMessage(floor, r.url, mediaWrap, 'regenerateFloorMedia');
                if (!committed) {
                    fail++;
                    continue;
                }
                pushGalleryEntry({ url, character, prompt: finalPrompt, mediaType: r.mediaType, format });
                ok++;
            } catch (err) {
                console.error(`[${extensionName}] Floor regenerate failed (floor=${floor}, prompt=${String(r.prompt).slice(0, 80)}):`, err);
                fail++;
            } finally {
                processingHashes.delete(promptHash);
            }
        }

        if (toast) toastr.clear(toast);
        if (fail === 0) toastr.success(`第 ${floor} 楼重新生成完成: 成功 ${ok} 张`);
        else toastr.warning(`第 ${floor} 楼重新生成完成: 成功 ${ok} 张,失败 ${fail} 张`);
    } finally {
        if (timer) clearInterval(timer);
        floorRegenBusy.delete(floor);
        scheduleMediaPreviewRender();
    }
}

// --- 测试生成 tab ---

let testGenTimer = null;
let testGenLastEntry = null;
let testGenBusy = false;

/** 把预览框切到指定状态:empty / generating(text) / image(url) / video(url) / error(text) */
function setTestPreview(state, payload) {
    const $empty = $('#test_preview_empty');
    const $img = $('#test_preview_img');
    const $video = $('#test_preview_video');
    const $status = $('#test_preview_status');
    if (!$empty.length) return;

    $empty.css('display', state === 'empty' ? 'block' : 'none');
    $img.css('display', state === 'image' ? 'block' : 'none');
    $video.css('display', state === 'video' ? 'block' : 'none');
    $status.css('display', state === 'generating' || state === 'error' ? 'block' : 'none');

    if (state === 'image') {
        releaseVideoEl($video); // 切走时释放上一轮视频持有的资源
        $img.attr('src', payload);
    } else if (state === 'video') {
        $img.attr('src', '');
        $video.attr('src', payload);
    } else {
        releaseVideoEl($video);
        if (state === 'generating' || state === 'error') {
            $status.text(payload || '');
            $status.css('color', state === 'error' ? 'var(--dangerColor, #c66)' : '');
        }
    }
}

/** 测试 tab 生成按钮主流程 */
async function runTestGenerate() {
    if (testGenBusy) return;
    const rawPrompt = $('#test_prompt_input').val().trim();
    if (!rawPrompt) { toastr.warning('提示词不能为空'); return; }
    const preset = getActivePreset();
    if (!preset) { toastr.warning('请先在「ComfyUI 配置」tab 选一个配置档'); return; }

    const mediaType = ($('#test_media_type').val() === 'video') ? 'video' : 'image';

    testGenBusy = true;
    $('#test_generate_btn').css('opacity', '0.5').css('pointer-events', 'none');

    let seconds = 0;
    setTestPreview('generating', `生成中... 0s`);
    if (testGenTimer) clearInterval(testGenTimer);
    testGenTimer = setInterval(() => {
        seconds++;
        setTestPreview('generating', `生成中... ${seconds}s`);
    }, 1000);

    try {
        // 视频时 generateViaComfyInner 内部超时自动放宽到 5min(多帧采样耗时数分钟),图片 30s
        const { url, format, character, finalPrompt } = await generateViaComfy(rawPrompt, mediaType, preset.name);

        // 用 preset.name 作为 character → 图库 tab 自动按 preset 分组。prompt 用 finalPrompt 快照(含前缀)
        const entry = { url, character, prompt: finalPrompt, mediaType, format, timestamp: Date.now() };
        pushGalleryEntry(entry);
        testGenLastEntry = entry;

        setTestPreview(mediaType, url);
    } catch (e) {
        console.error(`[${extensionName}] Test generate failed:`, e);
        setTestPreview('error', `生成失败: ${e.message || e}`);
    } finally {
        if (testGenTimer) { clearInterval(testGenTimer); testGenTimer = null; }
        $('#test_generate_btn').css('opacity', '').css('pointer-events', '');
        testGenBusy = false;
    }
}

function bindTestTabEvents() {
    $('#test_generate_btn').off('click.test').on('click.test', runTestGenerate);
    $('#test_prompt_input').off('keydown.test').on('keydown.test', function (e) {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            runTestGenerate();
        }
    });
    $('#test_preview_img').off('click.test').on('click.test', function () {
        if (testGenLastEntry) openGalleryLightbox(testGenLastEntry);
    });
    $('#test_media_type').off('change.test').on('change.test', function () {
        // 按钮文案跟媒体类型走(生成测试图 / 生成测试视频);生成中只改文案不干扰流程
        const isVideo = $(this).val() === 'video';
        $('#test_generate_btn').find('span').text(isVideo
            ? translate('生成测试视频', 'mag_test_generate_video_btn')
            : translate('生成测试图', 'mag_test_generate_btn'));
    });
    $('#test_paste_btn').off('click.test').on('click.test', async function () {
        try {
            const text = await navigator.clipboard.readText();
            if (!text) { toastr.warning('粘贴板为空'); return; }
            $('#test_prompt_input').val(text);
            toastr.success('已粘贴');
        } catch (e) {
            toastr.error('读取粘贴板失败(浏览器可能未授权)');
            console.error(`[${extensionName}] clipboard read failed:`, e);
        }
    });
    $('#test_clear_btn').off('click.test').on('click.test', function () {
        $('#test_prompt_input').val('');
        toastr.success('已清空');
    });
}

// --- 事件监听 ---

eventSource.on(event_types.GENERATION_STARTED, (type, options, dryRun) => {
    // dryRun 生成(Prompt-Template / QR2 等扩展只组装 prompt 的预演调用)也会 emit
    // GENERATION_STARTED(ST 无条件 emit,script.js:4240),但它不进 finishGenerating,
    // 永不 emit GENERATION_ENDED。若不过滤:isStreamActive 被拉起后等不到 ENDED,
    // 500ms 轮询永转、媒体永滞留(流式目标楼判定),冷却到期还会对旧标签无限重复
    // 触发生成;真实生成的 ENDED 落地窗口期(200ms 防抖)也会被紧随的 dryRun STARTED
    // 覆盖成死锁(2026-08 实测:regenerate 后 dryRun 抢在落地前 150ms 拉起流式态)。
    if (dryRun) {
        console.log(`[${extensionName}] GENERATION_STARTED(dryRun): 忽略,不进入流式状态`);
        return;
    }
    console.log(`[${extensionName}] GENERATION_STARTED(type=${type}): inFlight=${inFlightMedia.size} processing=${processingHashes.size}`);
    processingHashes.clear();
    // 注意:这里**不再**盲清 inFlightMedia——上一轮生成慢、完成时楼层已非最后一楼的媒体
    // 还等着本轮结束后的 landInFlightMedia() 落地,清了就变回"标签永不替换"的老 bug。
    // 失配(swipe/删除)条目由 landInFlightMedia 自行丢弃;切聊天由 CHAT_CHANGED 清。

    const context = getContext();
    if (!context.chat || context.chat.length === 0) return;

    // 快照生成开始时的最后楼 mes,sanitizeFreshLlmMessage 据此区分 continue 追加 / 新楼
    preGenerationMesSnapshot = { index: context.chat.length - 1, mes: String(context.chat[context.chat.length - 1]?.mes ?? '') };

    isStreamActive = true;
    if (streamInterval) clearInterval(streamInterval);

    // 自愈观察:ST 的 GENERATION_ENDED 唯一 emit 点是 hideStopButton(带 NOOP 保护——
    // 停止按钮从未显示过就不发)。凡 ENDED 丢失/被覆盖的路径(扩展接管生成、异常 early
    // return、ENDED 后紧跟 dryRun STARTED 把落地窗口覆盖等),isStreamActive 会永久卡 true、
    // 媒体永久滞留。这里盯住 ST 的 UI 锁定标志(deactivateSendButtons 设 'true' /
    // activateSendButtons 删除):见过 true 之后一旦被删,说明 ST 认为生成已结束,
    // 直接按流式结束收尾(与真 ENDED 重复执行无害,两路都是幂等的清理+落地)。
    // 用"曾见 true"门槛而非直接判空:STARTED 先于 UI 锁定 emit,流式未锁定的窗口期
    // (prompt 构建阶段)不能误判为已结束。
    let sawUiLocked = false;

    // 流式期间只触发生成，不修改界面
    streamInterval = setInterval(() => {
        if (!isStreamActive) { clearInterval(streamInterval); return; }
        if (document.body.dataset.generating === 'true') {
            sawUiLocked = true;
        } else if (sawUiLocked) {
            console.warn(`[${extensionName}] GENERATION_ENDED 丢失(UI 已解锁),轮询自愈按流式结束收尾`);
            onGenerationFinished();
            return;
        }
        processMessageContent(false, true);
    }, 500);
});

// 流式传输结束的回调
const onGenerationFinished = async () => {
    if (streamInterval) { clearInterval(streamInterval); streamInterval = null; }
    isStreamActive = false;

    try {
        await sanitizeFreshLlmMessage(); // 先剥 LLM 伪造的 mag-* HTML,再让最终处理面对干净 mes
    } catch (e) {
        console.error(`[${extensionName}] sanitizeFreshLlmMessage failed:`, e); // 防御:不让它异常挡住后面的落地
    }
    pruneOldPrompts();
    // 流式结束，申请一次最终更新
    requestDebouncedUpdate(true);
};

eventSource.on(event_types.GENERATION_ENDED, onGenerationFinished);
eventSource.on(event_types.GENERATION_STOPPED, onGenerationFinished);

// 非流式/加载时
eventSource.on(event_types.MESSAGE_RECEIVED, async () => {
    await sanitizeFreshLlmMessage(); // 新 AI 楼,mes 里的 mag-* HTML 必为 LLM 伪造
    pruneOldPrompts();
    await processMessageContent(true, false);
});

// 切聊天:清残留 in-flight(同 GENERATION_STARTED 的防泄漏理由,旧聊天的暂存媒体不该算进新聊天)
// + 关预览浮窗 + 旧楼层裸 [image]/[video] 标签转占位符(仅手动模式,见 processAllMessagesForPlaceholders,
//   内含嵌套占位符存量自愈) + 自动模式下单独跑一遍自愈(error 占位符也会被嵌套损坏)
eventSource.on(event_types.CHAT_CHANGED, async () => {
    if (inFlightMedia.size > 0) console.warn(`[${extensionName}] CHAT_CHANGED: 清空 ${inFlightMedia.size} 条滞留 in-flight 媒体`);
    inFlightMedia.clear();
    closeMediaPreviewModal();
    await processAllMessagesForPlaceholders();
    if (extension_settings[extensionName] && extension_settings[extensionName].autoReplace !== 'manual') {
        await healAllFloorsNestedPlaceholders();
    }
});

// 编辑消息保存后(ST emit MESSAGE_EDITED),让占位符 / 缓存媒体在编辑后的消息里重新渲染
// 否则用户编辑加 [image] 标签保存后看不到占位符,要刷新或重进聊天才出
eventSource.on(event_types.MESSAGE_EDITED, async () => {
    const landed = await landInFlightMedia(); // 编辑前触发的生成可能刚好完成,趁此落地
    await processMessageContent(true, false);
    scheduleMediaPreviewRender(); // 编辑可能增删楼层里的媒体 → 预览浮窗跟进
    if (landed > 0) {
        try { await getContext().saveChat(); } catch (e) { console.error(`[${extensionName}] saveChat failed:`, e); }
    }
});

// 发送给 LLM 前的 wrapper → [image]/[video] 还原已移交 ST Regex 扩展承担(配置见 README),
// 插件不再挂 GENERATE_AFTER_COMBINE_PROMPTS / CHAT_COMPLETION_PROMPT_READY 出口监听。
