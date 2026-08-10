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

const extensionName = 'media-auto-generation';
const extensionFolderPath = `/scripts/extensions/third-party/${extensionName}`;

// --- 全局状态管理 ---

let isStreamActive = false;
let streamInterval = null;
let updateDebounceTimer = null; 

// 1. 生成结果缓存 (Key: Hash -> Value: HTML Tag)
const generatedCache = new Map();

// 失败记录 (Key: Hash -> Value: errorMessage):自动模式 ComfyUI 失败时记录,流式结束后渲染 error 占位符让用户重试
const failedPrompts = new Map();

// 2. 历史记录 (冷却锁)
const promptHistory = new Map();

// 3. 并发处理锁 (生成锁)
const processingHashes = new Set();

// 冷却时间设置：3分钟
const PROMPT_COOLDOWN_MS = 180000;

// 默认设置 (新增 characterTags)
const defaultSettings = {
    mediaType: 'disabled',
    imageRegex: '/<pic\b(?![^>]*\bsrc\s*=)(?:(?:(?!\bprompt\b)[^>])*\blight_intensity\s*=\s*"([^"]*)")?(?:(?!\bprompt\b)[^>])*\bprompt\s*=\s*"([^"]*)"[^>]*>/gi',
    videoRegex: '/<video\b(?:(?:(?!\bprompt\b)[^>])*\bvideoParams\s*=\s*"([^"]*)")?(?:(?!\bprompt\b)[^>])*\bprompt\s*=\s*"([^"]*)"[^>]*>/gi',
    style: 'width:100%;height:auto',
    autoReplace: 'auto', // 'auto'=匹配后自动生成替换;'manual'=渲染成可点击占位符,手动点击触发生成
    characterTags: {}, // --- 新增: 角色固定特征字典 ---
    floatBtnPosition: null, // 浮动按钮位置 { left, top },null=默认右下角
    comfyPresets: [], // ComfyUI 配置档列表
    activePresetName: null, // 当前激活的配置档名字
    comfyUrls: [], // ComfyUI 服务地址簿(跨 preset 共享):[{ name, url }]
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

function pruneOldPrompts() {
    const now = Date.now();
    for (const [hash, timestamp] of promptHistory.entries()) {
        if (now - timestamp > PROMPT_COOLDOWN_MS) {
            promptHistory.delete(hash);
            generatedCache.delete(hash);
        }
    }
}

function escapeHtmlAttribute(value) {
    if (typeof value !== 'string') return '';
    return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * 把 mag-media wrapper(生成完成的图/视频)还原成简洁的 <pic prompt="..."> / <video prompt="...">,
 * 用于发给 LLM 前的清理 —— 避免 LLM 看到历史里的 wrapper HTML 后学着输出 HTML。
 *
 * mes 里 class 是原始 `mag-media`(DOMPurify 在渲染到 DOM 时才加 custom- 前缀,不会写回 mes),
 * 但为防御性同时匹配 custom-mag-media。
 *
 * wrapper 外层是单 <span> 无嵌套 <span>,所以 [\s\S]*?</span> 必然匹配到正确闭合。
 */
function reduceMagMediaForLLM(text) {
    if (typeof text !== 'string') return text;
    const wrapperRe = /<span\b[^>]*\bclass\s*=\s*"[^"]*\b(?:custom-)?mag-media\b[^"]*"[^>]*>[\s\S]*?<\/span>/gi;
    return text.replace(wrapperRe, (match) => {
        const typeMatch = match.match(/\bdata-media-type\s*=\s*"(image|video)"/i);
        const promptMatch = match.match(/\bdata-prompt\s*=\s*"([^"]*)"/i);
        if (!typeMatch || !promptMatch) return match;
        const tag = typeMatch[1] === 'video' ? 'video' : 'pic';
        // promptMatch[1] 已是 escapeHtmlAttribute 处理过的字符串,直接拼到新 attribute 即可
        return `<${tag} prompt="${promptMatch[1]}" />`;
    });
}

/**
 * 把 message.mes 中 data-mag-id 匹配的占位符 span 替换为 newTag。
 * 占位符 HTML 结构约定:外层只有一个 <span>(无嵌套 span),所以非贪婪 </span> 必然匹配到正确闭合。
 */
function replacePlaceholderInMes(mes, magId, newTag) {
    const escaped = escapeRegExp(magId);
    const re = new RegExp(`<span[^>]*data-mag-id="${escaped}"[^>]*>[\\s\\S]*?</span>`, '');
    return mes.replace(re, newTag);
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
 * @param {string} path ping/samplers/models/schedulers/vaes/generate
 * @param {object} body
 * @param {number} [timeoutMs=60000] 超时,超时后 abort 并抛"超时"错误
 */
async function comfyProxy(path, body, timeoutMs = 60_000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
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
            throw new Error(`ComfyUI ${path} 超时(${Math.round(timeoutMs / 1000)}s)`);
        }
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

const VIDEO_FORMATS = new Set(['mp4', 'webm', 'mov', 'avi', 'mkv']);

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
 */
function applyWorkflowPlaceholders(workflowJson, preset, prompt, negativePrompt) {
    const seed = Number.isFinite(preset.seed) && preset.seed >= 0
        ? preset.seed
        : Math.floor(Math.random() * 1_000_000_000);
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
 * 直接调远程 ComfyUI 生成媒体。返回 { url, format, character }。
 * url 是 ST 后端落盘后的文件路径(/user/images/...),避免 data URI 撑爆 DOM 和聊天存档。
 * @param {string} overrideCharacter 可选,覆盖 character(默认走 context.name2 / groupId / 'media')。测试 tab 传 preset.name。
 *
 * 外壳:入串行队列,真正执行交给 generateViaComfyInner。
 * 这样改 URL/工作流/前缀等配置后点重试,等到 job 真跑时会重新读 active preset,新配置立即生效。
 */
async function generateViaComfy(modifiedPrompt, mediaType, overrideCharacter) {
    return enqueueComfyJob(() => generateViaComfyInner(modifiedPrompt, mediaType, overrideCharacter));
}

async function generateViaComfyInner(modifiedPrompt, mediaType, overrideCharacter) {
    const preset = getActivePreset();
    if (!preset) throw new Error('No active ComfyUI preset configured');
    if (!preset.comfyUrl) throw new Error('Active preset has no ComfyUI URL');
    if (!preset.model) throw new Error('Active preset has no model selected');

    // 前缀末尾无逗号 → 自动补一个,避免 "1girl" + "solo" 粘连成 "1girlsolo"
    const prefix = (preset.positivePromptPrefix || '').trimEnd();
    const sep = prefix && !prefix.endsWith(',') ? ',' : '';
    const finalPrompt = prefix + sep + modifiedPrompt;
    const negativePrompt = preset.negativePromptPrefix || '';
    const workflow = applyWorkflowPlaceholders(preset.workflowJson, preset, finalPrompt, negativePrompt);

    const body = { url: preset.comfyUrl, prompt: `{ "prompt": ${workflow} }` };
    if (preset.comfyAuth) body.auth = preset.comfyAuth;

    const timeoutMs = mediaType === 'video' ? 120_000 : 20_000;
    const result = await comfyProxy('generate', body, timeoutMs);
    const format = (result.format || (mediaType === 'video' ? 'mp4' : 'png')).toLowerCase();

    const context = getContext();
    const charName = (overrideCharacter || context.name2 || context.groupId || 'media').replace(/[\\\/]/g, '_');
    const filename = `${mediaType}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const url = await saveBase64AsFile(result.data, charName, filename, format);

    return { url, format, character: charName, finalPrompt };
}

// --- 设置与UI逻辑 ---

// --- 配置档(Preset)UI 渲染 ---

// 缓存最近一次拉到的 model/sampler/scheduler 列表(避免每次切换 preset 都重新拉)
const comfyCache = { models: [], samplers: [], schedulers: [], url: '' };
function resetComfyCache() {
    comfyCache.models = [];
    comfyCache.samplers = [];
    comfyCache.schedulers = [];
    comfyCache.url = '';
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

/** 地址簿事件:select 切换 = 写回 input(联动 preset URL);保存 = 把当前 input URL 入簿;删除 = 移除 select 当前选中 */
function bindComfyUrlBookmarkEvents() {
    $('#comfy_url_bookmark').off('.urlBookmark').on('change.urlBookmark', function () {
        const v = String($(this).val() || '').trim();
        if (!v) return;
        // 写回 input 并触发 change → 已有的 .preset handler 会写回 activePreset.comfyUrl + 清缓存
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
    const preset = getActivePreset();
    const hasPreset = !!preset;
    $('#comfy_empty_hint').css('display', hasPreset ? 'none' : 'block');

    // 临时解绑所有字段事件,灌值后再绑回(避免连锁写)
    $('#comfy_url, #comfy_model, #comfy_sampler, #comfy_scheduler, #comfy_width, #comfy_height, #comfy_steps, #comfy_scale, #comfy_denoise, #comfy_seed, #comfy_pos_prefix, #comfy_neg_prefix, #comfy_workflow').off('.preset');

    $('#comfy_url').val(preset?.comfyUrl || '');
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

    // 字段使能状态(无 preset 时 disabled)
    $('#comfy_url, #comfy_url_bookmark, #comfy_url_save, #comfy_url_delete, #comfy_model, #comfy_sampler, #comfy_scheduler, #comfy_width, #comfy_height, #comfy_steps, #comfy_scale, #comfy_denoise, #comfy_seed, #comfy_pos_prefix, #comfy_neg_prefix, #comfy_workflow, #comfy_refresh').prop('disabled', !hasPreset);

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

function onPresetSelectChange() {
    const newName = $(this).val();
    extension_settings[extensionName].activePresetName = newName || null;
    saveSettingsDebounced();
    // 切换 preset 时清空已缓存的 model/sampler/scheduler 列表(可能对应不同 URL)
    resetComfyCache();
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
        writeField('comfyUrl', $(e.target).val().trim());
        // URL 改变 → 清缓存 + 清空 select options(强制刷新)
        resetComfyCache();
        renderComfySelect('#comfy_model', [], getActivePreset()?.model || '');
        renderComfySelect('#comfy_sampler', [], getActivePreset()?.sampler || '');
        renderComfySelect('#comfy_scheduler', [], getActivePreset()?.scheduler || '');
    });
    $('#comfy_pos_prefix').on('change.preset', (e) => writeField('positivePromptPrefix', $(e.target).val()));
    $('#comfy_neg_prefix').on('change.preset', (e) => writeField('negativePromptPrefix', $(e.target).val()));
    $('#comfy_workflow').on('change.preset', (e) => writeField('workflowJson', $(e.target).val()));

    $('#comfy_model').on('change.preset', (e) => writeField('model', $(e.target).val()));
    $('#comfy_sampler').on('change.preset', (e) => writeField('sampler', $(e.target).val()));
    $('#comfy_scheduler').on('change.preset', (e) => writeField('scheduler', $(e.target).val()));

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
        comfyUrl: '',
        comfyAuth: '',
        workflowJson: '',
        model: '', sampler: '', scheduler: '',
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
    if (!preset || !preset.comfyUrl) {
        toastr.warning('请先填 ComfyUI 服务地址');
        return;
    }
    toastr.info('正在连接 ComfyUI...');
    const body = { url: preset.comfyUrl };
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
        comfyCache.url = preset.comfyUrl;
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
            </div>
        `);
    }
}

/** 绑定 LoRA 强度输入 change(事件委托到容器,列表重渲染后不失效) */
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
        resetComfyCache();
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
    $('#auto_replace').on('change', function () { extension_settings[extensionName].autoReplace = $(this).val(); saveSettingsDebounced(); });
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
    // 手机端:按钮缩小(原 56 偏大);bottom 抬高避开 ST 底部 nav
    const btnSize = mobile ? 40 : 48;
    const btnFontSize = mobile ? 18 : 20;
    const btnRightGap = mobile ? 16 : 20;
    const btnBottomGap = mobile ? 90 : 20;
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
    $('#mag_wand_entry').off('click.mag').on('click.mag', function () {
        toggleFloatingPanel(true);
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
            $(document).off('mouseup touchend', onUp);
            $handle.css('cursor', 'grab');
            if (dragging) $panel.css('cursor', '');
        }

        $(document).on('mousemove touchmove', onMove);
        $(document).on('mouseup touchend', onUp);
    });
}

function initFloatBtnDrag() {
    const btn = $('#media_auto_gen_float_btn');
    const EDGE_THRESHOLD = 20;  // 距屏幕左右边 ≤20px 松手 → 吸附

    // 运行时吸附态(不持久化,刷新即解除)
    let dockedEdge = null;

    function setDocked(edge) {
        dockedEdge = edge;
        btn.removeClass('mag-docked-left mag-docked-right');
        if (edge) btn.addClass('mag-docked-' + edge);
    }

    let startX = 0, startY = 0;
    let originLeft = 0, originTop = 0;
    let elW = 0, elH = 0;
    let isDragging = false;
    let wasDocked = false;
    let lastTouchTs = 0;  // 阻止手机端 touchend 后浏览器合成的 mouse 兼容事件双触发

    function getPoint(e) {
        return (e.touches && e.touches[0]) ? e.touches[0] : e;
    }

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
        wasDocked = dockedEdge !== null;
        if (dockedEdge) {
            setDocked(null);
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
            $(document).off('mouseup touchend', onUp);
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
                setDocked('right');
            } else if (distLeft <= EDGE_THRESHOLD) {
                setDocked('left');
            }

            // 位置无论吸附与否都落盘(left/top 是吸附前的真实位置,刷新后从此处可见态开始)
            extension_settings[extensionName].floatBtnPosition = {
                left: left,
                top: parseInt(btn.css('top'), 10) || 0,
            };
            saveSettingsDebounced();
        }

        $(document).on('mousemove touchmove', onMove);
        $(document).on('mouseup touchend', onUp);
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
    updateDebounceTimer = setTimeout(() => {
        processMessageContent(isFinal, false); // 执行真正的替换
    }, 200); // 200ms 缓冲
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
    const matches = [...message.mes.matchAll(mediaTagRegex)];
    if (matches.length === 0) return;

    let contentModified = false;
    let currentMessageText = message.mes;
    
    let replacementStats = { image: 0, video: 0 };

    // 使用 entries() 获取当前是第几个匹配项 (index)
    for (const [index, match] of matches.entries()) {
        const originalTag = match[0];
        // 跳过已经是成品的标签
        if (originalTag.includes('src=') || originalTag.includes('src =')) continue;

        let rawPrompt = (match[2] || "").trim();
        let rawExtraParams = match[1] || "";

        if (!rawPrompt && match[1] && !match[0].includes('light_intensity') && !match[0].includes('videoParams')) {
            rawPrompt = match[1].trim();
            rawExtraParams = match[2] || "";
        }

        if (!rawPrompt) continue;

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
        const promptHash = simpleHash(normalizePrompt(modifiedPrompt));

        // --- 逻辑 A：替换已完成的图片 ---
        if (!onlyTrigger && generatedCache.has(promptHash)) {
            const cachedMediaTag = generatedCache.get(promptHash);
            
            // 执行文本替换
            currentMessageText = currentMessageText.replace(originalTag, cachedMediaTag);
            contentModified = true;
            
            if (cachedMediaTag.includes('<video')) replacementStats.video++;
            else replacementStats.image++;
            
            continue; 
        }

        // --- 逻辑 A-1：失败降级(自动模式 ComfyUI 失败,流式结束后渲染 error 占位符让用户手动重试)---
        if (!onlyTrigger && failedPrompts.has(promptHash)) {
            const placeholder = buildPlaceholder({ promptHash, index, mediaType, rawPrompt, rawExtraParams, originalTag, state: 'error', error: failedPrompts.get(promptHash) });
            currentMessageText = currentMessageText.replace(originalTag, placeholder);
            contentModified = true;
            continue;
        }

        // --- 逻辑 B-0：手动模式占位符 ---
        // 缓存未命中且 autoReplace='manual' 时,把 originalTag 替换为可点击占位符,不触发生成。
        // 用户点击占位符 → onPlaceholderClick → 触发生成 → 用 magId 字符串替换为最终 <img>/<video>。
        if (!autoReplace) {
            const placeholder = buildPlaceholder({ promptHash, index, mediaType, rawPrompt, rawExtraParams, originalTag, state: 'idle' });
            currentMessageText = currentMessageText.replace(originalTag, placeholder);
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
                    rawExtraParams,
                });

                generatedCache.set(promptHash, mediaTag);
                failedPrompts.delete(promptHash); // 兜底:同一 prompt 先失败后(在另一消息)自动成功,清残留失败记录

                // 记录到图库 manifest(供 Gallery tab 展示)。prompt 用 finalPrompt 快照(含前缀+角色注入)
                pushGalleryEntry({ url, character, prompt: finalPrompt, mediaType, format });

                // 成功后立即解锁
                processingHashes.delete(promptHash);

                // 非流式:每张完成立即触发 DOM 更新(绕开 200ms 防抖,避免多张同时完成被合并成一次"等齐"显示)
                // 流式:保持原逻辑,只在最后一张完成时触发(避免干扰流式渲染,GENERATION_ENDED 会兜底)
                if (!isStreamActive) {
                    await processMessageContent(false, false);
                } else if (processingHashes.size === 0) {
                    requestDebouncedUpdate(true);
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

        // 成功提示
        let successMsgParts = [];
        if (replacementStats.image > 0) successMsgParts.push(`${replacementStats.image} 张图片`);
        if (replacementStats.video > 0) successMsgParts.push(`${replacementStats.video} 个视频`);
        
        if (successMsgParts.length > 0) {
            toastr.success(`替换完成: ${successMsgParts.join(', ')}`);
        }
        
        // 触发保存
        await eventSource.emit(event_types.MESSAGE_UPDATED, messageIndex);
        if (isFinal) {
            const finalContext = getContext();
            await finalContext.saveChat();
        }
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
        if ($el.attr('data-state') === 'loading') return; // loading 中拒重入(idle/error 都允许触发)
        if ($el.attr('data-view') !== 'default') return; // prompt 视图下点主体不触发生成
        await startManualGeneration($el);
    } else if (isMedia) {
        e.preventDefault();
        const cur = $el.attr('data-revealed');
        $el.attr('data-revealed', cur === 'true' ? 'false' : 'true');
    }
}

/**
 * 手动模式占位符 → 触发 ComfyUI 生成 → 替换为 mag-media wrapper。
 * 从原 onPlaceholderClick 抽出来,统一 click handler 调用。
 */
async function startManualGeneration($ph) {
    const magId = $ph.attr('data-mag-id');
    const rawPrompt = $ph.attr('data-prompt');
    const rawExtraParams = $ph.attr('data-extra');
    const mediaType = $ph.attr('data-media-type');

    $ph.attr('data-state', 'loading');
    $ph.find('[data-mag-role="icon"]').attr('class', 'fa-solid fa-circle-notch fa-spin');

    // 注入角色特征 → 与自动模式一致地计算 hash(缓存命中复用)
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

        const { url, format, character, finalPrompt } = await generateViaComfy(modifiedPrompt, mediaType);
        clearInterval(timer);
        if (toast) toastr.clear(toast);

        const mediaWrap = buildMediaWrap({ magId, mediaType, url, rawPrompt, rawExtraParams });

        generatedCache.set(promptHash, mediaWrap);
        failedPrompts.delete(promptHash);
        pushGalleryEntry({ url, character, prompt: finalPrompt, mediaType, format });

        // 用 magId 锚定字符串替换 message.mes 中的占位符 → 最终 wrapper
        const context = getContext();
        const messageIndex = context.chat.length - 1;
        const message = context.chat[messageIndex];
        if (message) {
            message.mes = replacePlaceholderInMes(message.mes, magId, mediaWrap);
            updateMessageBlock(messageIndex, message);
            await eventSource.emit(event_types.MESSAGE_UPDATED, messageIndex);
            await context.saveChat();
        }
        toastr.success(`替换完成: 1 张${mediaTypeText}`);
    } catch (err) {
        console.error(`[${extensionName}] Manual generation failed:`, err);
        if (timer) clearInterval(timer);
        if (toast) toastr.clear(toast);
        toastr.error(`Media generation error: ${err.message || err}`);
        const errMsg = err.message || String(err);
        $ph.attr('data-state', 'error');
        $ph.attr('data-view', 'default'); // 失败时强制收起 prompt 视图,确保错误信息在 default 视图下可见
        $ph.attr('data-error', errMsg);
        $ph.find('[data-mag-role="icon"]').attr('class', 'fa-solid fa-triangle-exclamation');
        $ph.find('[data-mag-role="label"]').text('点击重试');
        $ph.find('[data-mag-role="prompt-text"]').text('⚠️ ' + errMsg.slice(0, 200));
    }
}

/**
 * 已生成的 mag-media wrapper → 重新调一次 ComfyUI 生成。
 * 与 startManualGeneration 的区别:入口是已生成图(不是占位符),每次都走 generateViaComfy
 * (该函数内部 getActivePreset() 实时读最新 ComfyUI 配置档,所以改完配置立即生效)。
 * 生成成功后:更新当前 wrapper 的 src + 覆盖 generatedCache(同 promptHash 后续命中也用新图)。
 * 不走 promptHistory 冷却检查(冷却只拦自动触发,手动重生成不拦)。
 */
async function regenerateMedia($media) {
    const magId = $media.attr('data-mag-id');
    const rawPrompt = $media.attr('data-prompt');
    const rawExtraParams = $media.attr('data-extra') || '';
    const mediaType = $media.attr('data-media-type');

    // 注入角色特征,与 startManualGeneration 一致地计算 hash(用于缓存覆盖)
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
        const mediaWrap = buildMediaWrap({ magId, mediaType, url, rawPrompt, rawExtraParams });

        // 更新缓存:覆盖同 promptHash 的旧 wrapper,后续新消息命中拿到的是新图
        generatedCache.set(promptHash, mediaWrap);
        failedPrompts.delete(promptHash);
        pushGalleryEntry({ url, character, prompt: finalPrompt, mediaType, format });

        // 同步到 message.mes + 重渲当前块
        const context = getContext();
        const messageIndex = context.chat.length - 1;
        const message = context.chat[messageIndex];
        if (message) {
            message.mes = replacePlaceholderInMes(message.mes, magId, mediaWrap);
            updateMessageBlock(messageIndex, message);
            await eventSource.emit(event_types.MESSAGE_UPDATED, messageIndex);
            await context.saveChat();
        }
        toastr.success(`已重新生成: 1 张${mediaTypeText}`);
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
function buildPlaceholder({ promptHash, index, mediaType, rawPrompt, rawExtraParams, originalTag, state, error }) {
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
    return `<span class="mag-placeholder ${phClass}" data-mag-id="${escapeHtmlAttribute(magId)}" data-state="${state}" data-view="default" data-prompt="${escapeHtmlAttribute(rawPrompt)}" data-extra="${escapeHtmlAttribute(rawExtraParams)}" data-media-type="${mediaType}" data-original-tag="${escapeHtmlAttribute(originalTag)}"${errorAttr} contenteditable="false"><i class="fa-solid ${iconClass}" data-mag-role="icon"></i><small data-mag-role="label">${labelText}</small><small data-mag-role="prompt-text">${escapeHtmlAttribute(promptText)}</small><i class="fa-solid fa-copy" data-mag-role="copy"></i><small data-mag-role="toggle">prompt描述</small></span>`;
}

/**
 * 构造 mag-media wrapper HTML(包 img/video + 4 个 data-mag-role 子元素)。
 * 占位符替换 / 自动模式缓存 共用此函数,保证产物结构一致。
 */
function buildMediaWrap({ magId, mediaType, url, rawPrompt, rawExtraParams }) {
    const style = extension_settings[extensionName].style || '';
    const escapedUrl = escapeHtmlAttribute(url);
    const escapedPrompt = escapeHtmlAttribute(rawPrompt);
    const escapedParams = escapeHtmlAttribute(rawExtraParams || '');
    const promptText = rawPrompt.length > 200 ? rawPrompt.slice(0, 200) + '...' : rawPrompt;
    const escapedPromptText = escapeHtmlAttribute(promptText);

    let mediaInner;
    if (mediaType === 'video') {
        mediaInner = `<video src="${escapedUrl}" ${escapedParams ? `videoParams="${escapedParams}"` : ''} prompt="${escapedPrompt}" style="${style}" loop controls autoplay muted/>`;
    } else {
        const lightAttr = escapedParams ? `light_intensity="${escapedParams}"` : 'light_intensity="0"';
        mediaInner = `<img src="${escapedUrl}" ${lightAttr} prompt="${escapedPrompt}" style="${style}" />`;
    }

    return `<span class="mag-media" data-mag-id="${escapeHtmlAttribute(magId)}" data-media-type="${mediaType}" data-prompt="${escapedPrompt}" data-extra="${escapedParams}" data-revealed="false" data-view="default" contenteditable="false">${mediaInner}<small data-mag-role="prompt-text">${escapedPromptText}</small><i class="fa-solid fa-copy" data-mag-role="copy"></i><small data-mag-role="prompt-toggle">prompt描述</small><small data-mag-role="regenerate">重新生成</small><small data-mag-role="zoom">放大</small></span>`;
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

// --- 测试生成 tab ---

let testGenTimer = null;
let testGenLastEntry = null;
let testGenBusy = false;

/** 把预览框切到指定状态:empty / generating(text) / image(url) / error(text) */
function setTestPreview(state, payload) {
    const $empty = $('#test_preview_empty');
    const $img = $('#test_preview_img');
    const $status = $('#test_preview_status');
    if (!$empty.length) return;

    $empty.css('display', state === 'empty' ? 'block' : 'none');
    $img.css('display', state === 'image' ? 'block' : 'none');
    $status.css('display', state === 'generating' || state === 'error' ? 'block' : 'none');

    if (state === 'image') {
        $img.attr('src', payload);
    } else if (state === 'generating' || state === 'error') {
        $status.text(payload || '');
        $status.css('color', state === 'error' ? 'var(--dangerColor, #c66)' : '');
    }
}

/** 测试 tab 生成按钮主流程 */
async function runTestGenerate() {
    if (testGenBusy) return;
    const rawPrompt = $('#test_prompt_input').val().trim();
    if (!rawPrompt) { toastr.warning('提示词不能为空'); return; }
    const preset = getActivePreset();
    if (!preset) { toastr.warning('请先在「ComfyUI 配置」tab 选一个配置档'); return; }

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
        const { url, format, character, finalPrompt } = await generateViaComfy(rawPrompt, 'image', preset.name);

        // 用 preset.name 作为 character → 图库 tab 自动按 preset 分组。prompt 用 finalPrompt 快照(含前缀)
        const entry = { url, character, prompt: finalPrompt, mediaType: 'image', format, timestamp: Date.now() };
        pushGalleryEntry(entry);
        testGenLastEntry = entry;

        setTestPreview('image', url);
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

eventSource.on(event_types.GENERATION_STARTED, () => {
    processingHashes.clear();

    const context = getContext();
    if (!context.chat || context.chat.length === 0) return;
    
    isStreamActive = true;
    if (streamInterval) clearInterval(streamInterval);
    
    // 流式期间只触发生成，不修改界面
    streamInterval = setInterval(() => {
        if (!isStreamActive) { clearInterval(streamInterval); return; }
        processMessageContent(false, true); 
    }, 500);
});

// 流式传输结束的回调
const onGenerationFinished = async () => {
    if (streamInterval) { clearInterval(streamInterval); streamInterval = null; }
    isStreamActive = false;
    
    pruneOldPrompts();
    // 流式结束，申请一次最终更新
    requestDebouncedUpdate(true);
};

eventSource.on(event_types.GENERATION_ENDED, onGenerationFinished);
eventSource.on(event_types.GENERATION_STOPPED, onGenerationFinished);

// 非流式/加载时
eventSource.on(event_types.MESSAGE_RECEIVED, async () => {
    pruneOldPrompts();
    await processMessageContent(true, false);
});

// 编辑消息保存后(ST emit MESSAGE_EDITED),让占位符 / 缓存媒体在编辑后的消息里重新渲染
// 否则用户编辑加 <pic prompt> 保存后看不到占位符,要刷新或重进聊天才出
eventSource.on(event_types.MESSAGE_EDITED, async () => {
    await processMessageContent(true, false);
});

// === 发送给 LLM 前:把 mag-media wrapper 还原成简洁 <pic>/<video> 标签 ===
// 覆盖两种模式: text completion 走 GENERATE_AFTER_COMBINE_PROMPTS, chat completion 走 CHAT_COMPLETION_PROMPT_READY
// 不分 dryRun,token 计数也要一致,否则 ST 会按 wrapper 长度估算偏高、误砍楼层

// text completion: payload 是 { prompt: string, dryRun }
eventSource.on(event_types.GENERATE_AFTER_COMBINE_PROMPTS, (eventData) => {
    if (eventData && typeof eventData.prompt === 'string') {
        eventData.prompt = reduceMagMediaForLLM(eventData.prompt);
    }
});

// chat completion: payload 是 { chat: Array<{role, content}>, dryRun }
// content 可能是 string 或多模态数组(vision),两种都要处理
eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, (eventData) => {
    if (!eventData || !Array.isArray(eventData.chat)) return;
    for (const msg of eventData.chat) {
        if (!msg) continue;
        if (typeof msg.content === 'string') {
            msg.content = reduceMagMediaForLLM(msg.content);
        } else if (Array.isArray(msg.content)) {
            for (const part of msg.content) {
                if (part && typeof part.text === 'string') {
                    part.text = reduceMagMediaForLLM(part.text);
                }
            }
        }
    }
});
