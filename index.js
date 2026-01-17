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
    promptHistory.set(promptHash, Date.now());

    const mediaTypeText = mediaType === 'image' ? '图片' : '视频';
    let finalPrompt = "";
    let toast = null;
    let timer = null;
    let seconds = 0;

    try {
        // =================================================================
        // 关键互斥区 (CRITICAL SECTION)
        // 无论流式还是非流式，进入这里必须排队。
        // 这样保证 setvar A -> substituteParams -> setvar B 不会乱序覆盖
        // =================================================================
        await (variableLock = variableLock.then(async () => {
            // 1. 设置变量
            if (info.macroString) await substituteParams(info.macroString);
            // 2. 获取替换后的 Prompt (此时变量是正确的)
            finalPrompt = await substituteParams(info.rawPrompt);
        }).catch(e => console.error("Lock error", e))); 
        // =================================================================
        // 互斥区结束。此时 finalPrompt 已经拿到了正确的 LoRA 参数。
        // 我们可以释放锁，让下一个任务进 critical section，
        // 同时当前任务继续往下跑网络请求 (并发)。
        // =================================================================

        // UI: 独立的倒计时 Toast
        const baseText = `正在生成第 ${index + 1} 张${mediaTypeText}...`;
        toast = toastr.info(`${baseText} ${seconds}s`, '', { timeOut: 0, extendedTimeOut: 0 });
        timer = setInterval(() => {
            seconds++;
            if (toast && toast.find) toast.find('.toast-message').text(`${baseText} ${seconds}s`);
        }, 1000);

        // 调用 SD (耗时操作，完全异步并发)
        const result = await SlashCommandParser.commands['sd'].callback({ quiet: 'true' }, finalPrompt);

        // 清理 UI
        if (timer) clearInterval(timer);
        if (toast) toastr.clear(toast);

        if (result && result.trim().length > 0) {
            const tag = buildMediaTag(result, info.rawPrompt, info.rawExtraParams, mediaType);
            
            // 写入缓存
            generatedCache.set(promptHash, tag);
            
            // 立即刷新界面！
            // 无论是在流式中间，还是非流式结束后，只要生成完一张，就刷一张。
            refreshCurrentMessageUI();
        }

    } catch (err) {
        console.error('Generation failed:', err);
        if (timer) clearInterval(timer);
        if (toast) toastr.clear(toast);
        toastr.error(`生成第 ${index + 1} 张失败`);
        // 失败允许重试
        promptHistory.delete(promptHash);
    } finally {
        // 任务结束，释放 Hash 锁
        processingHashes.delete(promptHash);
    }
}

/**
 * 统一扫描与触发逻辑
 * 这是一个非阻塞函数。调用它会瞬间遍历文本，触发所有未开始的任务，然后立即返回。
 */
function scanAndTrigger(isStreaming) {
    if (!extension_settings[extensionName] || extension_settings[extensionName].mediaType === 'disabled') return;
    
    const context = getContext();
    const message = context.chat[context.chat.length - 1];
    if (!message || message.is_user || !message.mes) return;

    const mediaType = extension_settings[extensionName].mediaType;
    const regexStr = mediaType === 'image' ? extension_settings[extensionName].imageRegex : extension_settings[extensionName].videoRegex;
    const matches = [...message.mes.matchAll(regexFromString(regexStr))];

    for (const [index, match] of matches.entries()) {
        const originalTag = match[0];
        if (originalTag.includes('src=') || originalTag.includes('src =')) continue;

        const info = extractPromptInfo(match, mediaType);
        if (!info) continue;

        const promptHash = simpleHash(normalizePrompt(info.rawPrompt));

        // 检查是否已缓存/正在运行/冷却中
        if (generatedCache.has(promptHash)) {
             // 如果在缓存里但界面上没显示（极端情况），这里不处理，交给 refreshCurrentMessageUI
             continue;
        }
        if (processingHashes.has(promptHash)) continue;
        
        const now = Date.now();
        if (promptHistory.has(promptHash)) {
             if (now - promptHistory.get(promptHash) < PROMPT_COOLDOWN_MS) continue;
        }

        // 触发并发任务 (Fire-and-Forget)
        // 我们不 await 这个任务，直接让循环继续，去触发下一张图
        triggerGenerationTask(index, info, mediaType, promptHash);
    }
}

// --- 事件监听 ---

eventSource.on(event_types.GENERATION_STARTED, () => {
    processingHashes.clear();
    
    // 只有勾选了流式才启动定时器
    if (!extension_settings[extensionName]?.streamGeneration) return;

    isStreamActive = true;
    if (streamInterval) clearInterval(streamInterval);
    
    // 流式监听：高频扫描，实时触发
    streamInterval = setInterval(() => {
        if (!isStreamActive) { clearInterval(streamInterval); return; }
        scanAndTrigger(true); // isStreaming = true
        // 流式期间也可以尝试刷新界面，把已经好的图显示出来
        refreshCurrentMessageUI(); 
    }, 500);
});

const onGenerationFinished = async () => {
    if (streamInterval) { clearInterval(streamInterval); streamInterval = null; }
    isStreamActive = false;
    pruneOldPrompts();
};

eventSource.on(event_types.GENERATION_ENDED, onGenerationFinished);
eventSource.on(event_types.GENERATION_STOPPED, onGenerationFinished);

// 非流式/消息接收完毕
// 这里的逻辑现在变成了：立即扫描并触发所有任务，绝不阻塞用户看字
eventSource.on(event_types.MESSAGE_RECEIVED, async () => {
    onGenerationFinished();
    
    // 1. 尝试先把缓存里的图刷出来
    refreshCurrentMessageUI();
    
    // 2. 扫描并触发所有剩余的图 (非阻塞)
    // 这一步会瞬间启动所有后台任务
    scanAndTrigger(false); 
});
