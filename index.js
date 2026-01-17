// 媒体自动生成插件主脚本 - V5.0 (终极体验优化版)
// 核心特性：
// 1. 严格顺序调度 (Sequential Dispatch)：按文本顺序发送请求，确保后台接收顺序。
// 2. 异步并行执行 (Async Execution)：发送请求后不等待结果，直接处理下一张，最大化并发。
// 3. 智能 UI 隔离：
//    - 流式传输时：完全静默，结束后统一上屏 (解决闪烁)。
//    - 非流式时：生成一张显示一张 (解决等待焦虑)。
// 4. 变量安全：通过调度链保证 SetVar 绝对不冲突。

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

// 1. 缓存 (Hash -> HTML Tag)
const generatedCache = new Map();
// 2. 历史记录 (Hash -> Timestamp)
const promptHistory = new Map();
// 3. 正在处理集合 (Hash) - 防止重复提交
const processingHashes = new Set();

// 4. 调度链 (关键)：保证请求按顺序发出
let dispatchChain = Promise.resolve();

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
    // 兼容不同的正则捕获组位置
    let rawExtraParams = match[1] || "";
    let rawPrompt = (match[2] || "").trim();

    // 尝试交换捕获组容错
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

// --- 设置逻辑 (保持简洁) ---
async function loadSettings() {
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    if (Object.keys(extension_settings[extensionName]).length === 0) Object.assign(extension_settings[extensionName], defaultSettings);
    else for (const key in defaultSettings) if (extension_settings[extensionName][key] === undefined) extension_settings[extensionName][key] = defaultSettings[key];
}
async function createSettings(settingsHtml) {
    if (!$('#media_auto_generation_container').length) $('#extensions_settings2').append('<div id="media_auto_generation_container" class="extension_container"></div>');
    $('#media_auto_generation_container').empty().append(settingsHtml);
    // Bind events
    const bindSave = (sel, prop) => $(sel).on('input change', function() { 
        extension_settings[extensionName][prop] = prop === 'streamGeneration' ? $(this).prop('checked') : $(this).val(); 
        saveSettingsDebounced(); 
    });
    bindSave('#mediaType', 'mediaType');
    bindSave('#image_regex', 'imageRegex');
    bindSave('#video_regex', 'videoRegex');
    bindSave('#media_style', 'style');
    bindSave('#stream_generation', 'streamGeneration');
    
    // Init values
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

// --- 核心业务逻辑 (V5 架构) ---

/**
 * 刷新 UI 界面
 * @param {boolean} force 是否强制刷新 (忽略流式状态)
 */
function refreshCurrentMessageUI(force = false) {
    // 关键控制：如果是流式传输中，且不是强制刷新，则坚决不更新 UI，防止闪烁
    if (isStreamActive && !force) return;

    if (!extension_settings[extensionName] || extension_settings[extensionName].mediaType === 'disabled') return;

    const context = getContext();
    const messageIndex = context.chat.length - 1;
    const message = context.chat[messageIndex];
    if (!message || message.is_user || !message.mes) return;

    const mediaType = extension_settings[extensionName].mediaType;
    const regexStr = mediaType === 'image' ? extension_settings[extensionName].imageRegex : extension_settings[extensionName].videoRegex;
    
    let currentMessageText = message.mes;
    let contentModified = false;
    
    const mediaTagRegex = regexFromString(regexStr);
    
    // 扫描并替换已缓存的内容
    currentMessageText = currentMessageText.replace(mediaTagRegex, (match, ...args) => {
        const captureGroups = args.slice(0, -2);
        const matchObj = [match, ...captureGroups];
        
        if (match.includes('src=') || match.includes('src =')) return match;

        const info = extractPromptInfo(matchObj, mediaType);
        if (!info) return match;

        const promptHash = simpleHash(normalizePrompt(info.rawPrompt));
        
        if (generatedCache.has(promptHash)) {
            contentModified = true;
            return generatedCache.get(promptHash);
        }
        return match;
    });

    if (contentModified) {
        message.mes = currentMessageText;
        updateMessageBlock(messageIndex, message);
        
        // 如果是流式结束后的全量更新，可以稍微激进一点，否则防抖
        if (updateDebounceTimer) clearTimeout(updateDebounceTimer);
        const delay = force ? 50 : 200; 
        updateDebounceTimer = setTimeout(async () => {
            await eventSource.emit(event_types.MESSAGE_UPDATED, messageIndex);
        }, delay);
    }
}

/**
 * 后台执行生成任务 (异步，不阻塞调度链)
 */
async function runBackgroundGeneration(index, finalPrompt, info, mediaType, promptHash) {
    let toast = null;
    let timer = null;
    let seconds = 0;
    const mediaTypeText = mediaType === 'image' ? '图片' : '视频';

    try {
        // UI: 独立的倒计时 (任务开始执行才弹出)
        const baseText = `生成第 ${index + 1} 张${mediaTypeText}...`;
        toast = toastr.info(`${baseText} ${seconds}s`, '', { timeOut: 0, extendedTimeOut: 0 });
        timer = setInterval(() => {
            seconds++;
            if (toast && toast.find) toast.find('.toast-message').text(`${baseText} ${seconds}s`);
        }, 1000);

        // 调用 SD (耗时操作)
        const result = await SlashCommandParser.commands['sd'].callback({ quiet: 'true' }, finalPrompt);

        // 清理 UI
        if (timer) clearInterval(timer);
        if (toast) toastr.clear(toast);

        if (result && result.trim().length > 0) {
            const tag = buildMediaTag(result, info.rawPrompt, info.rawExtraParams, mediaType);
            generatedCache.set(promptHash, tag);
            
            // 【关键策略】：生成完一张，尝试刷新 UI
            // 如果 isStreamActive 为 true，refreshCurrentMessageUI 会自动拦截，不刷新
            // 如果流式已结束 (isStreamActive = false)，会立即刷新，实现"后来居上"
            refreshCurrentMessageUI(false); 
        }

    } catch (err) {
        console.error(`[${extensionName}] Task ${index+1} failed:`, err);
        if (timer) clearInterval(timer);
        if (toast) toastr.clear(toast);
        // 失败允许重试
        promptHistory.delete(promptHash);
        processingHashes.delete(promptHash);
    } finally {
        // 任务彻底结束，移除锁
        // 注意：processingHashes 主要用于防止重复提交，不影响调度链
        // 调度链已经在提交请求后就释放了
    }
}

/**
 * 调度器：将任务加入顺序执行链
 * 核心逻辑：Promise Chain 只负责 (SetVar -> GetPrompt -> CallAPI)，不等待 Response
 */
function scheduleTask(index, info, mediaType, promptHash) {
    if (processingHashes.has(promptHash) || generatedCache.has(promptHash)) return;

    processingHashes.add(promptHash);
    promptHistory.set(promptHash, Date.now());

    // 链接到调度链尾部
    dispatchChain = dispatchChain.then(async () => {
        try {
            // 1. 设置变量 (串行，确保安全)
            if (info.macroString) await substituteParams(info.macroString);
            
            // 2. 获取 Prompt (串行，确保拿到当前变量下的 Prompt)
            const finalPrompt = await substituteParams(info.rawPrompt);

            // 3. 启动后台任务 (Fire-and-Forget)
            // 关键：这里不 await runBackgroundGeneration，
            // 只要请求发出了，或者参数准备好了，就立刻返回，让链条处理下一个任务
            runBackgroundGeneration(index, finalPrompt, info, mediaType, promptHash);
            
        } catch (e) {
            console.error("Dispatch error:", e);
            processingHashes.delete(promptHash);
        }
    });
}

/**
 * 文本扫描器
 */
function scanAndSchedule() {
    if (!extension_settings[extensionName] || extension_settings[extensionName].mediaType === 'disabled') return;
    
    const context = getContext();
    const message = context.chat[context.chat.length - 1];
    if (!message || message.is_user || !message.mes) return;

    const mediaType = extension_settings[extensionName].mediaType;
    const regexStr = mediaType === 'image' ? extension_settings[extensionName].imageRegex : extension_settings[extensionName].videoRegex;
    const matches = [...message.mes.matchAll(regexFromString(regexStr))];

    // 按文本顺序遍历，依次加入调度链
    for (const [index, match] of matches.entries()) {
        const originalTag = match[0];
        if (originalTag.includes('src=') || originalTag.includes('src =')) continue;

        const info = extractPromptInfo(match, mediaType);
        if (!info) continue;

        const promptHash = simpleHash(normalizePrompt(info.rawPrompt));
        scheduleTask(index, info, mediaType, promptHash);
    }
}

// --- 事件监听 ---

eventSource.on(event_types.GENERATION_STARTED, () => {
    // 每次开始新生成，重置部分状态
    // 注意：不清除 generatedCache，因为可能有上一轮没跑完的图（虽然概率小）
    // processingHashes 也不清除，维持任务状态
    
    if (!extension_settings[extensionName]?.streamGeneration) return;

    isStreamActive = true;
    if (streamInterval) clearInterval(streamInterval);
    
    streamInterval = setInterval(() => {
        if (!isStreamActive) { clearInterval(streamInterval); return; }
        // 1. 扫描并调度新出现的标签 (后台执行)
        scanAndSchedule();
        // 2. 流式期间绝不调用 refreshCurrentMessageUI，防止闪烁
    }, 500);
});

const onGenerationFinished = async () => {
    if (streamInterval) { clearInterval(streamInterval); streamInterval = null; }
    isStreamActive = false;
    
    pruneOldPrompts();
    
    // 【关键】：流式结束时刻
    // 1. 立即强制刷新一次 UI，把所有流式期间在后台生成好的图显示出来
    refreshCurrentMessageUI(true); // force = true
};

eventSource.on(event_types.GENERATION_ENDED, onGenerationFinished);
eventSource.on(event_types.GENERATION_STOPPED, onGenerationFinished);

// 非流式场景 / 历史加载 / 兜底
eventSource.on(event_types.MESSAGE_RECEIVED, async () => {
    // 确保流式标志位关闭
    isStreamActive = false;
    if (streamInterval) clearInterval(streamInterval);

    // 1. 扫描并调度所有任务
    // 因为 isStreamActive = false，runBackgroundGeneration 内部会在生成完一张后立即刷新 UI
    scanAndSchedule();
});
