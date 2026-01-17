// 媒体自动生成插件主脚本 - V4.0 (并发修正版)
// 特性：
// 1. 恢复全异步并行触发 (Fire-and-Forget)，解决阻塞问题。
// 2. 引入 Mutex 互斥锁，仅在设置变量的微秒级瞬间串行，确保 LoRA 强度不冲突。
// 3. 非流式模式下，消息立即显示，图片在后台生成后动态“上屏”。
// 4. 恢复每个任务独立的 Toast 倒计时。

import { extension_settings, getContext } from '../../../extensions.js';
import {
    saveSettingsDebounced,
    eventSource,
    event_types,
    updateMessageBlock,
    substituteParams 
} from '../../../../script.js';
import { regexFromString } from '../../../utils.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';

const extensionName = 'media-auto-generation';
const extensionFolderPath = `/scripts/extensions/third-party/${extensionName}`;

// --- 全局状态管理 ---

let isStreamActive = false;
let streamInterval = null;
let updateDebounceTimer = null;

// 1. 缓存与状态锁
const generatedCache = new Map(); // Hash -> HTML Tag
const promptHistory = new Map();  // Hash -> Timestamp
const processingHashes = new Set(); // Hash (正在处理中)

// 2. 关键：变量设置互斥锁 (Promise Chain)
// 只有拿到这个锁的任务才能执行 setvar，防止并发覆盖
let variableLock = Promise.resolve();

const PROMPT_COOLDOWN_MS = 180000;

const defaultSettings = {
    mediaType: 'disabled',
    imageRegex: '/<pic\\b(?![^>]*\\bsrc\\s*=)(?:(?:(?!\\bprompt\\b)[^>])*\\blight_intensity\\s*=\\s*"([^"]*)")?(?:(?!\\bprompt\\b)[^>])*\\bprompt\\s*=\\s*"([^"]*)"[^>]*>/gi',
    videoRegex: '/<video\\b(?:(?:(?!\\bprompt\\b)[^>])*\\bvideoParams\\s*=\\s*"([^"]*)")?(?:(?!\\bprompt\\b)[^>])*\\bprompt\\s*=\\s*"([^"]*)"[^>]*>/gi',
    style: 'width:auto;height:auto',
    streamGeneration: false,
};

// --- 工具函数 ---

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

function extractPromptInfo(match, mediaType) {
    let rawExtraParams = match[1] || "";
    let rawPrompt = (match[2] || "").trim();

    if (!rawPrompt && match[1] && !match[0].includes('light_intensity') && !match[0].includes('videoParams')) {
        rawPrompt = match[1].trim();
        rawExtraParams = match[2] || "";
    }

    if (!rawPrompt) return null;

    let macroString = "";
    if (mediaType === 'video') {
        if (rawExtraParams) {
            const params = rawExtraParams.split(',').map(s => s.trim());
            if (params.length === 3) {
                macroString = `{{setvar::videoFrameCount::${params[0]}}}{{setvar::videoWidth::${params[1]}}}{{setvar::videoHeight::${params[2]}}}`;
            }
        }
    } else {
        if (rawExtraParams) {
            const intensityArr = rawExtraParams.split(',').map(s => s.trim());
            const lightIntensity = intensityArr[0] ? intensityArr[0] : 0;
            const sunshineIntensity = intensityArr[1] ? intensityArr[1] : 0;
            macroString = `{{setvar::light_intensity::${lightIntensity}}}{{setvar::sunshine_intensity::${sunshineIntensity}}}`;
        }
    }

    return { rawPrompt, rawExtraParams, macroString };
}

function buildMediaTag(resultUrl, rawPrompt, rawParams, mediaType) {
    const style = extension_settings[extensionName].style || '';
    const escapedUrl = escapeHtmlAttribute(resultUrl);
    const escapedOriginalPrompt = escapeHtmlAttribute(rawPrompt);
    const escapedParams = escapeHtmlAttribute(rawParams);

    if (mediaType === 'video') {
        return `<video src="${escapedUrl}" ${escapedParams ? `videoParams="${escapedParams}"` : ''} prompt="${escapedOriginalPrompt}" style="${style}" loop controls autoplay muted/>`;
    } else {
        const lightAttr = escapedParams ? `light_intensity="${escapedParams}"` : 'light_intensity="0"';
        return `<img src="${escapedUrl}" ${lightAttr} prompt="${escapedOriginalPrompt}" style="${style}" onclick="window.open(this.src)" />`;
    }
}

// --- 设置逻辑 (UI) ---
// (这部分保持不变，省略以节省篇幅，与之前版本一致)
async function loadSettings() {
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    if (Object.keys(extension_settings[extensionName]).length === 0) Object.assign(extension_settings[extensionName], defaultSettings);
    else for (const key in defaultSettings) if (extension_settings[extensionName][key] === undefined) extension_settings[extensionName][key] = defaultSettings[key];
}
async function createSettings(settingsHtml) {
    if (!$('#media_auto_generation_container').length) $('#extensions_settings2').append('<div id="media_auto_generation_container" class="extension_container"></div>');
    $('#media_auto_generation_container').empty().append(settingsHtml);
    $('#mediaType').on('change', function () { extension_settings[extensionName].mediaType = $(this).val(); saveSettingsDebounced(); });
    $('#image_regex').on('input', function () { extension_settings[extensionName].imageRegex = $(this).val(); saveSettingsDebounced(); });
    $('#video_regex').on('input', function () { extension_settings[extensionName].videoRegex = $(this).val(); saveSettingsDebounced(); });
    $('#media_style').on('input', function () { extension_settings[extensionName].style = $(this).val(); saveSettingsDebounced(); });
    $('#stream_generation').on('change', function () { extension_settings[extensionName].streamGeneration = $(this).prop('checked'); saveSettingsDebounced(); });
    if ($('#mediaType').length) {
        $('#mediaType').val(extension_settings[extensionName].mediaType);
        $('#image_regex').val(extension_settings[extensionName].imageRegex);
        $('#video_regex').val(extension_settings[extensionName].videoRegex);
        $('#media_style').val(extension_settings[extensionName].style);
        $('#stream_generation').prop('checked', extension_settings[extensionName].streamGeneration ?? false);
    }
}
$(function () {
    (async function () {
        const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
        $('#extensionsMenu').append(`<div id="auto_generation" class="list-group-item flex-container flexGap5"><div class="fa-solid fa-film"></div><span data-i18n="Media Auto Generation">Media Auto Generation</span></div>`);
        $('#auto_generation').off('click').on('click', () => { $('#extensions-settings-button .drawer-toggle').trigger('click'); setTimeout(() => { $('#media_auto_generation_container .inline-drawer-header').trigger('click'); }, 500); });
        await loadSettings();
        await createSettings(settingsHtml);
    })();
});


// --- 核心业务逻辑 (V4 架构) ---

/**
 * 通用：刷新当前消息界面
 * 只要缓存里有图，就替换进去。非阻塞。
 */
function refreshCurrentMessageUI() {
    if (!extension_settings[extensionName] || extension_settings[extensionName].mediaType === 'disabled') return;

    const context = getContext();
    const messageIndex = context.chat.length - 1;
    const message = context.chat[messageIndex];
    if (!message || message.is_user || !message.mes) return;

    const mediaType = extension_settings[extensionName].mediaType;
    const regexStr = mediaType === 'image' ? extension_settings[extensionName].imageRegex : extension_settings[extensionName].videoRegex;
    
    let currentMessageText = message.mes;
    let contentModified = false;
    
    // 使用 replace 的回调函数进行一次性扫描替换
    const mediaTagRegex = regexFromString(regexStr);
    currentMessageText = currentMessageText.replace(mediaTagRegex, (match, ...args) => {
        // 重构 match 对象以复用 extractPromptInfo
        // match 是完整字符串，args 包含捕获组，最后一个是 offset，倒数第二个是原字符串
        // 我们需要手动构造类似 matchAll 返回的数组结构
        const captureGroups = args.slice(0, -2);
        const matchObj = [match, ...captureGroups];
        
        // 如果是成品，不处理
        if (match.includes('src=') || match.includes('src =')) return match;

        const info = extractPromptInfo(matchObj, mediaType);
        if (!info) return match;

        const promptHash = simpleHash(normalizePrompt(info.rawPrompt));
        
        // 只有缓存里有的才替换
        if (generatedCache.has(promptHash)) {
            contentModified = true;
            return generatedCache.get(promptHash);
        }
        
        // 还没生成的，保持原样（显示为 <pic...> 标签或者用户自定义的文本）
        return match;
    });

    if (contentModified) {
        message.mes = currentMessageText;
        updateMessageBlock(messageIndex, message);
        // 触发保存
        if (updateDebounceTimer) clearTimeout(updateDebounceTimer);
        updateDebounceTimer = setTimeout(async () => {
            await eventSource.emit(event_types.MESSAGE_UPDATED, messageIndex);
        }, 500);
    }
}

/**
 * 核心任务执行器：线程安全地获取Prompt，然后并发生成
 */
async function triggerGenerationTask(index, info, mediaType, promptHash) {
    // 再次检查 (Double Check)
    if (processingHashes.has(promptHash) || generatedCache.has(promptHash)) return;

    // 标记为正在处理
    processingHashes.add(promptHash);
    promptHistory.set(promptHash, Date
