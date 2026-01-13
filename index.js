// 媒体自动生成插件主脚本 - 并发修复版 (防抖队列+原子化更新)

import { extension_settings, getContext } from '../../../extensions.js';
import {
    saveSettingsDebounced,
    eventSource,
    event_types,
    updateMessageBlock,
} from '../../../../script.js';
import { regexFromString } from '../../../utils.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';

const extensionName = 'media-auto-generation';
const extensionFolderPath = `/scripts/extensions/third-party/${extensionName}`;

// --- 全局状态管理 ---

let isStreamActive = false;
let streamInterval = null;
let updateDebounceTimer = null; // 【新增】更新请求的防抖定时器

// 1. 生成结果缓存
const generatedCache = new Map();

// 2. 历史记录 (冷却锁)
const promptHistory = new Map();

// 3. 并发处理锁 (生成锁)
const processingHashes = new Set();

// 冷却时间设置：3分钟
const PROMPT_COOLDOWN_MS = 180000;

// 默认设置
const defaultSettings = {
    mediaType: 'disabled',
    imageRegex: '/<img\\b(?:(?:(?!\\bprompt\\b)[^>])*\\blight_intensity\\s*=\\s*"([^"]*)")?(?:(?!\\bprompt\\b)[^>])*\\bprompt\\s*=\\s*"([^"]*)"[^>]*>/gi',
    videoRegex: '/<video\b(?:(?:(?!\bprompt\b)[^>])*\bvideoParams\s*=\s*"([^"]*)")?(?:(?!\bprompt\b)[^>])*\bprompt\s*=\s*"([^"]*)"[^>]*>/gi',
    style: 'width:auto;height:auto',
    streamGeneration: false,
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

// --- 设置与UI逻辑 ---

function updateUI() {
    if ($('#mediaType').length) {
        $('#mediaType').val(extension_settings[extensionName].mediaType);
        $('#image_regex').val(extension_settings[extensionName].imageRegex);
        $('#video_regex').val(extension_settings[extensionName].videoRegex);
        $('#media_style').val(extension_settings[extensionName].style);
        $('#stream_generation').prop('checked', extension_settings[extensionName].streamGeneration ?? false);
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
    updateUI();
}

async function createSettings(settingsHtml) {
    if (!$('#media_auto_generation_container').length) {
        $('#extensions_settings2').append('<div id="media_auto_generation_container" class="extension_container"></div>');
    }
    $('#media_auto_generation_container').empty().append(settingsHtml);

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

    updateUI();
}

function onExtensionButtonClick() {
    const extensionsDrawer = $('#extensions-settings-button .drawer-toggle');
    if ($('#rm_extensions_block').hasClass('closedDrawer')) extensionsDrawer.trigger('click');
    setTimeout(() => {
        const container = $('#media_auto_generation_container');
        if (container.length) {
            $('#rm_extensions_block').animate({ scrollTop: container.offset().top - $('#rm_extensions_block').offset().top + $('#rm_extensions_block').scrollTop() }, 500);
            const drawerContent = container.find('.inline-drawer-content');
            const drawerHeader = container.find('.inline-drawer-header');
            if (drawerContent.is(':hidden') && drawerHeader.length) drawerHeader.trigger('click');
        }
    }, 500);
}

$(function () {
    (async function () {
        const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
        $('#extensionsMenu').append(`<div id="auto_generation" class="list-group-item flex-container flexGap5"><div class="fa-solid fa-film"></div><span data-i18n="Media Auto Generation">Media Auto Generation</span></div>`);
        $('#auto_generation').off('click').on('click', onExtensionButtonClick);
        await loadSettings();
        await createSettings(settingsHtml);
        $('#extensions-settings-button').on('click', function () { setTimeout(() => { updateUI(); }, 200); });
    })();
});

// --- 核心处理逻辑 ---

/**
 * 请求一次防抖更新
 * 当多张图片几乎同时生成完毕时，这会合并更新操作，防止并发写入导致部分图片丢失
 */
function requestDebouncedUpdate(isFinal = false) {
    if (updateDebounceTimer) clearTimeout(updateDebounceTimer);
    updateDebounceTimer = setTimeout(() => {
        processMessageContent(isFinal, false); // 执行真正的替换
    }, 200); // 200ms 的缓冲期
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

    for (const match of matches) {
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

        const promptHash = simpleHash(normalizePrompt(rawPrompt));

        // --- 逻辑 A：替换已完成的图片 ---
        if (!onlyTrigger && generatedCache.has(promptHash)) {
            const cachedMediaTag = generatedCache.get(promptHash);
            
            // 执行文本替换
            currentMessageText = currentMessageText.replace(originalTag, cachedMediaTag);
            contentModified = true;
            
            // 统计
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
            try {
                let finalPrompt = rawPrompt;
                if (mediaType === 'video') {
                    if (rawExtraParams && rawExtraParams.trim()) {
                        const params = rawExtraParams.split(',');
                        if (params.length === 3) {
                            const [frameCount, width, height] = params;
                            finalPrompt = `{{setvar::videoFrameCount::${frameCount}}}{{setvar::videoWidth::${width}}}{{setvar::videoHeight::${height}}}` + rawPrompt;
                        }
                    }
                } else {
                    if (rawExtraParams && rawExtraParams.trim()) {
                        const intensityArr = rawExtraParams.split(',').map(item => item.trim());
                        if (intensityArr.length === 2) {
                            const lightIntensity = Math.round(parseFloat(intensityArr[0]) * 100) / 100 || 0;
                            const sunshineIntensity = Math.round(parseFloat(intensityArr[1]) * 100) / 100 || 0;
                            finalPrompt = `{{setvar::light_intensity::${lightIntensity}}}{{setvar::sunshine_intensity::${sunshineIntensity}}}` + rawPrompt;
                        }
                    }
                }

                const mediaTypeText = mediaType === 'image' ? 'image' : 'video';
                const toastrOptions = { timeOut: 0, extendedTimeOut: 0, closeButton: true };
                
                // Loading 占位符 (Toast)
                const baseText = `⏳ 生成 ${mediaTypeText} (${rawPrompt.substring(0, 10)}...)...`;
                let toast = toastr.info(`${baseText} ${seconds}s`, '', toastrOptions);

                timer = setInterval(() => {
                    seconds++;
                    const $toastElement = $(`.toast-message:contains("${baseText}")`).closest('.toast');
                    if ($toastElement.length) $toastElement.find('.toast-message').text(`${baseText} ${seconds}s`);
                    else clearInterval(timer);
                }, 1000);

                const result = await SlashCommandParser.commands['sd'].callback({ quiet: 'true' }, finalPrompt);

                clearInterval(timer);
                toastr.clear(toast);

                if (typeof result === 'string' && result.trim().length > 0) {
                    const style = extension_settings[extensionName].style || '';
                    const escapedUrl = escapeHtmlAttribute(result);
                    const escapedOriginalPrompt = escapeHtmlAttribute(rawPrompt);
                    const escapedParams = escapeHtmlAttribute(rawExtraParams);

                    let mediaTag;
                    if (mediaType === 'video') {
                        mediaTag = `<video src="${escapedUrl}" ${escapedParams ? `videoParams="${escapedParams}"` : ''} prompt="${escapedOriginalPrompt}" style="${style}" loop controls autoplay muted/>`;
                    } else {
                        const lightAttr = escapedParams ? `light_intensity="${escapedParams}"` : 'light_intensity="0"';
                        mediaTag = `<img src="${escapedUrl}" ${lightAttr} prompt="${escapedOriginalPrompt}" style="${style}" onclick="window.open(this.src)" />`;
                    }

                    generatedCache.set(promptHash, mediaTag);

                    // 【核心修复】：图片生成好了，如果不处于流式传输中，申请一次防抖更新
                    // 这样即使 7 张图同时完成，也只会触发一次最终的 DOM 更新
                    if (!isStreamActive) {
                        requestDebouncedUpdate(true); 
                        // 通知保存是在 update 逻辑里做的，但为了保险，可以在 requestDebouncedUpdate 之后触发 save
                        // 但由于 requestDebouncedUpdate 是异步的，这里只要确保界面更新即可
                    }
                } else {
                     throw new Error("Empty result from SD");
                }

            } catch (error) {
                console.error(`[${extensionName}] Generation failed:`, error);
                if (timer) clearInterval(timer);
                toastr.error(`Media generation error: ${error}`);
                promptHistory.delete(promptHash);
            } finally {
                processingHashes.delete(promptHash);
            }
        })();
    }

    // --- 提交更新 ---
    if (!onlyTrigger && contentModified) {
        message.mes = currentMessageText;
        // 同步更新 UI，确保本次操作是原子的（在 JS 单线程模型下）
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

// --- 事件监听 ---

eventSource.on(event_types.GENERATION_STARTED, () => {
    processingHashes.clear();
    
    if (!extension_settings[extensionName]?.streamGeneration) return;

    const context = getContext();
    if (!context.chat || context.chat.length === 0) return;
    
    isStreamActive = true;
    if (streamInterval) clearInterval(streamInterval);
    
    // 流式期间只触发生成 (onlyTrigger=true)，不修改界面，不闪烁
    streamInterval = setInterval(() => {
        if (!isStreamActive) { clearInterval(streamInterval); return; }
        processMessageContent(false, true); 
    }, 500);
});

eventSource.on(event_types.STREAM_TOKEN_RECEIVED, () => {
    // 可以在这里加逻辑，目前由 setInterval 处理已足够
});

const onGenerationFinished = async () => {
    if (streamInterval) { clearInterval(streamInterval); streamInterval = null; }
    isStreamActive = false;
    
    pruneOldPrompts();
    // 流式结束，申请一次更新（处理那些比文字生成快的图片）
    requestDebouncedUpdate(true);
};

eventSource.on(event_types.GENERATION_ENDED, onGenerationFinished);
eventSource.on(event_types.GENERATION_STOPPED, onGenerationFinished);

// 非流式/加载时，直接允许替换
eventSource.on(event_types.MESSAGE_RECEIVED, async () => {
    pruneOldPrompts();
    await processMessageContent(true, false);
});
