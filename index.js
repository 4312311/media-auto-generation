// 媒体自动生成插件主脚本 - 最终完善版 (v3.1)
// 修复：流式传输末尾几张图片不显示的问题 (Orphaned Tasks Issue)
// 核心逻辑：流式任务完成后主动触发界面刷新，不再单纯依赖收尾检查

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

// 缓存与锁
const generatedCache = new Map(); // Hash -> HTML Tag
const promptHistory = new Map();  // Hash -> Timestamp (冷却)
const processingHashes = new Set(); // Hash (正在处理中)

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
}

async function createSettings(settingsHtml) {
    if (!$('#media_auto_generation_container').length) {
        $('#extensions_settings2').append('<div id="media_auto_generation_container" class="extension_container"></div>');
    }
    $('#media_auto_generation_container').empty().append(settingsHtml);
    // UI Event Listeners
    $('#mediaType').on('change', function () {
        extension_settings[extensionName].mediaType = $(this).val();
        saveSettingsDebounced();
    });
    $('#image_regex').on('input', function () { extension_settings[extensionName].imageRegex = $(this).val(); saveSettingsDebounced(); });
    $('#video_regex').on('input', function () { extension_settings[extensionName].videoRegex = $(this).val(); saveSettingsDebounced(); });
    $('#media_style').on('input', function () { extension_settings[extensionName].style = $(this).val(); saveSettingsDebounced(); });
    $('#stream_generation').on('change', function () { extension_settings[extensionName].streamGeneration = $(this).prop('checked'); saveSettingsDebounced(); });
    
    // 初始化值
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
        $('#auto_generation').off('click').on('click', () => {
             // 打开设置面板逻辑简写
             $('#extensions-settings-button .drawer-toggle').trigger('click');
             setTimeout(() => { $('#media_auto_generation_container .inline-drawer-header').trigger('click'); }, 500);
        });
        await loadSettings();
        await createSettings(settingsHtml);
    })();
});

// --- 核心业务逻辑 ---

/**
 * 【关键修复】应用缓存到当前消息
 * 这个函数是线程安全的刷新机制。无论流式任务何时结束，只要调用它，
 * 它就会重新读取当前消息文本，把所有已经生成好的（在缓存里的）标签全部替换掉。
 */
async function applyCacheToCurrentMessage() {
    if (!extension_settings[extensionName] || extension_settings[extensionName].mediaType === 'disabled') return;

    const context = getContext();
    const messageIndex = context.chat.length - 1;
    const message = context.chat[messageIndex];
    if (!message || message.is_user || !message.mes) return;

    const mediaType = extension_settings[extensionName].mediaType;
    const regexStr = mediaType === 'image' ? extension_settings[extensionName].imageRegex : extension_settings[extensionName].videoRegex;
    const mediaTagRegex = regexFromString(regexStr);

    let currentMessageText = message.mes; // 获取最新文本
    let contentModified = false;

    const matches = [...currentMessageText.matchAll(mediaTagRegex)];
    
    for (const match of matches) {
        const originalTag = match[0];
        if (originalTag.includes('src=') || originalTag.includes('src =')) continue;

        const info = extractPromptInfo(match, mediaType);
        if (!info) continue;

        const promptHash = simpleHash(normalizePrompt(info.rawPrompt));

        // 只要缓存里有，就替换！
        if (generatedCache.has(promptHash)) {
            currentMessageText = currentMessageText.replace(originalTag, generatedCache.get(promptHash));
            contentModified = true;
        }
    }

    if (contentModified) {
        // 更新 UI
        message.mes = currentMessageText;
        updateMessageBlock(messageIndex, message);
        
        // 防抖保存，避免高频 IO
        if (updateDebounceTimer) clearTimeout(updateDebounceTimer);
        updateDebounceTimer = setTimeout(async () => {
            await eventSource.emit(event_types.MESSAGE_UPDATED, messageIndex);
        }, 200);
    }
}

/**
 * 管道 1：流式处理 (并发)
 */
async function processStreamPipeline() {
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

        // 已经开始处理或已有结果，跳过
        if (processingHashes.has(promptHash) || generatedCache.has(promptHash)) continue;
        
        // 冷却检查
        const now = Date.now();
        if (promptHistory.has(promptHash)) {
             if (now - promptHistory.get(promptHash) < PROMPT_COOLDOWN_MS) continue;
        }

        // 锁定
        processingHashes.add(promptHash);
        promptHistory.set(promptHash, now);

        // 异步生成任务
        (async () => {
            try {
                // 1. 设置变量 (Await 确保顺序)
                if (info.macroString) await substituteParams(info.macroString);
                
                // 2. 准备 Prompt
                const finalPrompt = await substituteParams(info.rawPrompt);

                // UI Toast
                const mediaTypeText = mediaType === 'image' ? '图片' : '视频';
                toastr.info(`流式: 生成第 ${index + 1} 张${mediaTypeText}...`, '', { timeOut: 3000 });

                // 3. 调用 SD
                const result = await SlashCommandParser.commands['sd'].callback({ quiet: 'true' }, finalPrompt);
                
                if (result && result.trim().length > 0) {
                    const tag = buildMediaTag(result, info.rawPrompt, info.rawExtraParams, mediaType);
                    // 写入缓存
                    generatedCache.set(promptHash, tag);
                    
                    // 【关键修复点】：生成完成后，立即触发一次“打补丁”
                    // 这样即使此时 MESSAGE_RECEIVED 已经结束，界面也会被刷新
                    await applyCacheToCurrentMessage();
                }
            } catch (err) {
                console.error('Stream generation failed:', err);
                promptHistory.delete(promptHash);
            } finally {
                processingHashes.delete(promptHash);
            }
        })();
    }
}

/**
 * 管道 2：非流式/兜底处理 (严格串行)
 */
async function processSerialPipeline() {
    if (!extension_settings[extensionName] || extension_settings[extensionName].mediaType === 'disabled') return;

    // 1. 先尝试用已有缓存刷一遍 (快速处理流式已经完成的部分)
    await applyCacheToCurrentMessage();

    const context = getContext();
    const messageIndex = context.chat.length - 1;
    const message = context.chat[messageIndex];
    if (!message || message.is_user || !message.mes) return;

    const mediaType = extension_settings[extensionName].mediaType;
    const regexStr = mediaType === 'image' ? extension_settings[extensionName].imageRegex : extension_settings[extensionName].videoRegex;
    const matches = [...message.mes.matchAll(regexFromString(regexStr))];
    
    let fallbackWarningTriggered = false;

    // 2. 串行处理剩余未生成的
    for (const [index, match] of matches.entries()) {
        const originalTag = match[0];
        if (originalTag.includes('src=') || originalTag.includes('src =')) continue;

        const info = extractPromptInfo(match, mediaType);
        if (!info) continue;

        const promptHash = simpleHash(normalizePrompt(info.rawPrompt));

        // 再次检查缓存 (可能刚刚流式任务结束写入了)
        if (generatedCache.has(promptHash)) {
            // 如果缓存有了，直接调通用函数刷一下界面
            await applyCacheToCurrentMessage();
            continue;
        }

        // 检查是否正在流式处理中
        if (processingHashes.has(promptHash)) {
            // 【重要】：如果流式任务正在跑，我们这里不要动，也不要 continue 放弃
            // 因为 processStreamPipeline 里的异步任务完成后，会自己调用 applyCacheToCurrentMessage
            // 所以这里直接跳过即可，信任流式管道
            continue;
        }

        // 冷却检查
        const now = Date.now();
        if (promptHistory.has(promptHash)) {
             if (now - promptHistory.get(promptHash) < PROMPT_COOLDOWN_MS) continue;
        }

        // 触发兜底警告
        if (extension_settings[extensionName].streamGeneration && !fallbackWarningTriggered) {
            toastr.warning('检测到流式传输未覆盖部分图片（或瞬间加载），已自动切换为串行补全模式。', '模式切换', { timeOut: 5000 });
            fallbackWarningTriggered = true;
        }

        // 锁定并开始串行生成
        processingHashes.add(promptHash);
        promptHistory.set(promptHash, now);

        let timer;
        let seconds = 0;
        let toast = null;

        try {
            if (info.macroString) await substituteParams(info.macroString);
            const finalPrompt = await substituteParams(info.rawPrompt);

            const mediaTypeText = mediaType === 'image' ? '图片' : '视频';
            const baseText = `⏳ [串行] 生成第 ${index + 1} 张${mediaTypeText}...`;
            toast = toastr.info(`${baseText} ${seconds}s`, '', { timeOut: 0, extendedTimeOut: 0 });
            timer = setInterval(() => { seconds++; if (toast && toast.find) toast.find('.toast-message').text(`${baseText} ${seconds}s`); }, 1000);

            const result = await SlashCommandParser.commands['sd'].callback({ quiet: 'true' }, finalPrompt);

            clearInterval(timer);
            if (toast) toastr.clear(toast);

            if (result && result.trim().length > 0) {
                const tag = buildMediaTag(result, info.rawPrompt, info.rawExtraParams, mediaType);
                generatedCache.set(promptHash, tag);
                // 生成完一张，立即刷界面
                await applyCacheToCurrentMessage();
            }

        } catch (err) {
            console.error('Serial generation failed:', err);
            if (timer) clearInterval(timer);
            if (toast) toastr.clear(toast);
            promptHistory.delete(promptHash);
        } finally {
            processingHashes.delete(promptHash);
        }
    }
    
    // 最后保存一次
    const finalContext = getContext();
    await finalContext.saveChat();
}

// --- 事件监听 ---

eventSource.on(event_types.GENERATION_STARTED, () => {
    processingHashes.clear();
    if (!extension_settings[extensionName]?.streamGeneration) return;

    isStreamActive = true;
    if (streamInterval) clearInterval(streamInterval);
    
    streamInterval = setInterval(() => {
        if (!isStreamActive) { clearInterval(streamInterval); return; }
        processStreamPipeline(); 
    }, 500);
});

const onGenerationFinished = async () => {
    if (streamInterval) { clearInterval(streamInterval); streamInterval = null; }
    isStreamActive = false;
    pruneOldPrompts();
};

eventSource.on(event_types.GENERATION_ENDED, onGenerationFinished);
eventSource.on(event_types.GENERATION_STOPPED, onGenerationFinished);

// 消息完全接收后，执行兜底串行检查
eventSource.on(event_types.MESSAGE_RECEIVED, async () => {
    onGenerationFinished();
    await processSerialPipeline();
});
