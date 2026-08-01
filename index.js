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
import { regexFromString, clamp, getUniqueName, saveBase64AsFile } from '../../../utils.js';
import { isMobile } from '../../../RossAscends-mods.js';

const extensionName = 'media-auto-generation';
const extensionFolderPath = `/scripts/extensions/third-party/${extensionName}`;

// --- 全局状态管理 ---

let isStreamActive = false;
let streamInterval = null;
let updateDebounceTimer = null; 

// 1. 生成结果缓存 (Key: Hash -> Value: HTML Tag)
const generatedCache = new Map();

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
    streamGeneration: false,
    characterTags: {}, // --- 新增: 角色固定特征字典 ---
    floatBtnPosition: null, // 浮动按钮位置 { left, top },null=默认右下角
    comfyPresets: [], // ComfyUI 配置档列表
    activePresetName: null, // 当前激活的配置档名字
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

/**
 * 通用 ComfyUI 代理调用,body 已含 url(+ 可选 auth),passthrough 给 /api/sd/comfy/<path>
 * @param {string} path ping/samplers/models/schedulers/vaes/generate
 * @param {object} body
 */
async function comfyProxy(path, body) {
    const res = await fetch(`/api/sd/comfy/${path}`, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`ComfyUI ${path} failed: ${text}`);
    }
    return await res.json();
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
 */
async function generateViaComfy(modifiedPrompt, mediaType, overrideCharacter) {
    const preset = getActivePreset();
    if (!preset) throw new Error('No active ComfyUI preset configured');
    if (!preset.comfyUrl) throw new Error('Active preset has no ComfyUI URL');
    if (!preset.model) throw new Error('Active preset has no model selected');

    const finalPrompt = (preset.positivePromptPrefix || '') + modifiedPrompt;
    const negativePrompt = preset.negativePromptPrefix || '';
    const workflow = applyWorkflowPlaceholders(preset.workflowJson, preset, finalPrompt, negativePrompt);

    const body = { url: preset.comfyUrl, prompt: `{ "prompt": ${workflow} }` };
    if (preset.comfyAuth) body.auth = preset.comfyAuth;

    const result = await comfyProxy('generate', body);
    const format = (result.format || (mediaType === 'video' ? 'mp4' : 'png')).toLowerCase();

    const context = getContext();
    const charName = (overrideCharacter || context.name2 || context.groupId || 'media').replace(/[\\\/]/g, '_');
    const filename = `${mediaType}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const url = await saveBase64AsFile(result.data, charName, filename, format);

    return { url, format, character: charName };
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
    $('#comfy_url, #comfy_model, #comfy_sampler, #comfy_scheduler, #comfy_width, #comfy_height, #comfy_steps, #comfy_scale, #comfy_denoise, #comfy_seed, #comfy_pos_prefix, #comfy_neg_prefix, #comfy_workflow, #comfy_refresh').prop('disabled', !hasPreset);

    bindPresetFieldEvents();
    renderPresetPreview();
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

/** 并发拉取 model/sampler/scheduler 列表,单个失败不阻断 */
async function refreshComfyOptions() {
    const preset = getActivePreset();
    if (!preset || !preset.comfyUrl) {
        toastr.warning('Set ComfyUI URL first');
        return;
    }
    // 防止同 URL 重复拉取(用户连点)
    if (comfyCache.url === preset.comfyUrl && (comfyCache.models.length || comfyCache.samplers.length || comfyCache.schedulers.length)) {
        renderPresetFields();
        return;
    }
    toastr.info('Loading ComfyUI options...');
    const body = { url: preset.comfyUrl };
    if (preset.comfyAuth) body.auth = preset.comfyAuth;
    const results = await Promise.allSettled([
        comfyProxy('models', body),
        comfyProxy('samplers', body),
        comfyProxy('schedulers', body),
    ]);
    const [modelsR, samplersR, schedulersR] = results;
    if (modelsR.status === 'fulfilled') comfyCache.models = modelsR.value;
    else toastr.warning(`Failed to load models: ${modelsR.reason?.message || modelsR.reason}`);
    if (samplersR.status === 'fulfilled') comfyCache.samplers = samplersR.value;
    else toastr.warning(`Failed to load samplers: ${samplersR.reason?.message || samplersR.reason}`);
    if (schedulersR.status === 'fulfilled') comfyCache.schedulers = schedulersR.value;
    else toastr.warning(`Failed to load schedulers: ${schedulersR.reason?.message || schedulersR.reason}`);
    comfyCache.url = preset.comfyUrl;
    renderPresetFields();
}

// --- 预览图上传/删除 ---

const PREVIEW_MAX_BYTES = 8 * 1024 * 1024; // 8MB
const PREVIEW_FILENAME_PREFIX = 'mag-preset_preview_';

/** 把 base64 + 文件名上传到 ST 通用文件目录,返回相对路径(可直接当 <img src>) */
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
    const filename = `${PREVIEW_FILENAME_PREFIX}${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;

    const res = await fetch('/api/files/upload', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ name: filename, data: base64 }),
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Upload failed: ${text}`);
    }
    const result = await res.json();
    return result.path;
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
    const trimmed = val.trim();
    if (trimmed) {
        try { JSON.parse(trimmed); }
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
}

function renderWorkflowPopover(val) {
    const { used, invalid } = getWorkflowPlaceholderUsage(val || '');
    const phRow = (icon, color, k) =>
        `<div class="mag_ph_item"><i class="fa-solid ${icon}" style="color:${color}; width:14px; text-align:center;"></i><code>%${k}%</code></div>`;
    const rows = SUPPORTED_PLACEHOLDERS.map(k => {
        const ok = used.has(k);
        return phRow(ok ? 'fa-check' : 'fa-xmark', ok ? 'var(--green)' : 'var(--red)', k);
    });
    const invalidHtml = invalid.length
        ? `<hr class="mag_ph_divider">${invalid.map(k => phRow('fa-triangle-exclamation', 'var(--red)', k)).join('')}`
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

function bindPresetEvents() {
    $('#comfy_preset_new').off('click').on('click', createPreset);
    $('#comfy_preset_dup').off('click').on('click', duplicatePreset);
    $('#comfy_preset_rename').off('click').on('click', renamePreset);
    $('#comfy_preset_delete').off('click').on('click', deletePreset);
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
        $('#stream_generation').prop('checked', extension_settings[extensionName].streamGeneration ?? false);

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
    // 配置档迁移:确保 comfyPresets 是数组,失效的 activePresetName 回落
    if (!Array.isArray(extension_settings[extensionName].comfyPresets)) {
        extension_settings[extensionName].comfyPresets = [];
    }
    const presets = extension_settings[extensionName].comfyPresets;
    const activeName = extension_settings[extensionName].activePresetName;
    if (activeName && !presets.some(p => p.name === activeName)) {
        extension_settings[extensionName].activePresetName = presets[0]?.name ?? null;
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
    $('#stream_generation').on('change', function () { extension_settings[extensionName].streamGeneration = $(this).prop('checked'); saveSettingsDebounced(); });

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
                const { url, format, character } = await generateViaComfy(modifiedPrompt, mediaType);

                clearInterval(timer);
                if (toast) toastr.clear(toast);

                // format 与 mediaType 不匹配只警告,不阻断
                const isVideoFormat = VIDEO_FORMATS.has(format);
                if (mediaType === 'video' && !isVideoFormat) {
                    toastr.warning(`ComfyUI returned image format "${format}" but media type is video; tag may not render.`);
                } else if (mediaType === 'image' && isVideoFormat) {
                    toastr.warning(`ComfyUI returned video format "${format}" but media type is image; tag may not render.`);
                }

                const style = extension_settings[extensionName].style || '';
                const escapedUrl = escapeHtmlAttribute(url);
                // HTML标签上依然保留原始的 rawPrompt 避免文本污染,后台生成使用 modifiedPrompt
                const escapedOriginalPrompt = escapeHtmlAttribute(rawPrompt);
                const escapedParams = escapeHtmlAttribute(rawExtraParams);

                let mediaTag;
                if (mediaType === 'video') {
                    mediaTag = `<video src="${escapedUrl}" ${escapedParams ? `videoParams="${escapedParams}"` : ''} prompt="${escapedOriginalPrompt}" style="${style}" loop controls autoplay muted/>`;
                } else {
                    const lightAttr = escapedParams ? `light_intensity="${escapedParams}"` : 'light_intensity="0"';
                    mediaTag = `<img src="${escapedUrl}" ${lightAttr} prompt="${escapedOriginalPrompt}" style="${style}" />`;
                }

                generatedCache.set(promptHash, mediaTag);

                // 记录到图库 manifest(供 Gallery tab 展示)
                pushGalleryEntry({ url, character, prompt: rawPrompt, mediaType, format });

                // 成功后立即解锁
                processingHashes.delete(promptHash);

                // 兜底更新:非流式 或 队列清空时强制更新
                if (!isStreamActive || processingHashes.size === 0) {
                    requestDebouncedUpdate(true);
                }

            } catch (error) {
                console.error(`[${extensionName}] Generation failed:`, error);
                if (timer) clearInterval(timer);
                if (toast) toastr.clear(toast);
                toastr.error(`Media generation error: ${error.message || error}`);

                // 出错清理
                promptHistory.delete(promptHash);
                processingHashes.delete(promptHash);
            } finally {
                // 兜底清理
                if (processingHashes.has(promptHash)) {
                    processingHashes.delete(promptHash);
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
                <div class="lightbox-prompt"></div>
            </div>
        </div>
    `);
    const $lb = $('#mag_gallery_lightbox');
    $lb.find('.lightbox-close').on('click', closeGalleryLightbox);
    // 点击非媒体区域(遮罩本身)关闭
    $lb.on('click', (e) => {
        if (e.target === e.currentTarget) closeGalleryLightbox();
    });
    $(document).on('keydown.galleryLightbox', (e) => {
        if (e.key === 'Escape') closeGalleryLightbox();
    });
}

/** 打开 lightbox 显示指定 entry */
function openGalleryLightbox(entry) {
    ensureGalleryLightbox();
    const $lb = $('#mag_gallery_lightbox');
    const $img = $lb.find('img.lightbox-media');
    const $video = $lb.find('video.lightbox-media');
    const $prompt = $lb.find('.lightbox-prompt');

    if (entry.mediaType === 'video') {
        $img.css('display', 'none').attr('src', '');
        $video.css('display', 'block').attr('src', entry.url);
    } else {
        releaseVideoEl($video.css('display', 'none'));
        $img.css('display', 'block').attr('src', entry.url);
    }
    $prompt.text(entry.prompt || '');
    $lb.addClass('open');
}

/** 关闭 lightbox,释放 video 资源 */
function closeGalleryLightbox() {
    const $lb = $('#mag_gallery_lightbox');
    if (!$lb.length || !$lb.hasClass('open')) return;
    $lb.removeClass('open');
    releaseVideoEl($lb.find('video.lightbox-media'));
}

/** 渲染 gallery panel:按角色分组、缩略图网格 */
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

    const groups = new Map();
    for (let i = 0; i < manifest.length; i++) {
        const entry = manifest[i];
        const key = entry.character || 'media';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push({ entry, index: i });
    }

    // 组内:timestamp 倒序;组间:按组内最新 timestamp 倒序
    for (const arr of groups.values()) {
        arr.sort((a, b) => (b.entry.timestamp || 0) - (a.entry.timestamp || 0));
    }
    const sortedGroups = [...groups.entries()].sort((a, b) => {
        const aMax = a[1][0]?.entry.timestamp || 0;
        const bMax = b[1][0]?.entry.timestamp || 0;
        return bMax - aMax;
    });

    $container.empty();
    sortedGroups.forEach(([charName, items], groupIdx) => {
        const escapedName = escapeHtmlAttribute(charName);
        const openAttr = groupIdx === 0 ? ' open' : '';
        let thumbsHtml = '';
        for (const { entry, index } of items) {
            const escapedUrl = escapeHtmlAttribute(entry.url);
            const isVideo = entry.mediaType === 'video' || VIDEO_FORMATS.has(entry.format);
            const badge = isVideo ? `<div class="gallery-video-badge"><i class="fa-solid fa-play"></i></div>` : '';
            const tag = isVideo
                ? `<video class="gallery-thumb" src="${escapedUrl}" muted preload="metadata" playsinline></video>`
                : `<img class="gallery-thumb" src="${escapedUrl}" loading="lazy" />`;
            const timeStr = formatGalleryTime(entry.timestamp);
            thumbsHtml += `<div class="gallery-thumb-wrap" data-index="${index}">${tag}${badge}<div class="gallery-thumb-time">${timeStr}</div></div>`;
        }
        $container.append(`
            <details class="gallery-group"${openAttr}>
                <summary>
                    <span class="gallery-char-name" title="${escapedName}">${escapedName}</span>
                    <small>(${items.length})</small>
                </summary>
                <div class="gallery-grid">${thumbsHtml}</div>
            </details>
        `);
    });
}

/** 绑定 gallery 缩略图点击(事件委托) */
function bindGalleryEvents() {
    ensureGalleryLightbox();
    $('#gallery_container').off('click.gallery').on('click.gallery', '.gallery-thumb-wrap', function () {
        const idx = parseInt($(this).attr('data-index'), 10);
        const manifest = extension_settings[extensionName].galleryManifest || [];
        const entry = manifest[idx];
        if (entry) openGalleryLightbox(entry);
    });
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
        const { url, format, character } = await generateViaComfy(rawPrompt, 'image', preset.name);

        // 用 preset.name 作为 character → 图库 tab 自动按 preset 分组
        const entry = { url, character, prompt: rawPrompt, mediaType: 'image', format, timestamp: Date.now() };
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
}

// --- 事件监听 ---

eventSource.on(event_types.GENERATION_STARTED, () => {
    processingHashes.clear();
    
    if (!extension_settings[extensionName]?.streamGeneration) return;

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
