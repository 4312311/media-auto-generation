// 媒体自动生成插件主脚本 - 终极修复版 (静默预生成+统一替换+成功统计)

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
let realStreamingDetected = false;
let finalCheckTimer = null;

// 1. 生成结果缓存
// Key: Prompt Hash, Value: 完整的HTML标签 (<img src="..." ...>)
const generatedCache = new Map();

// 2. 历史记录 (冷却锁)
// Key: Prompt Hash, Value: 上次生成的时间戳
const promptHistory = new Map();

// 3. 并发处理锁 (内存锁)
// Key: Prompt Hash. 存在于此集合中表示正在生成中
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

/**
 * 简单的字符串 Hash 函数 (DJB2 算法)
 */
function simpleHash(str) {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
        hash = (hash * 33) ^ str.charCodeAt(i);
    }
    return (hash >>> 0).toString(16);
}

/**
 * 标准化 Prompt
 */
function normalizePrompt(str) {
    if (!str) return "";
    return str.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * 清理过期的 Prompt 历史
 */
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

// --- 设置与UI逻辑 (保持不变) ---

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

// --- 核心处理逻辑 (静默预生成 + 统一替换) ---

/**
 * 处理消息内容
 * @param {boolean} isFinal 是否是最终检查（生成结束）
 * @param {boolean} onlyTrigger 如果为 true，只触发后台生成，不执行文本替换（用于流式防抖）
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
    
    // 统计本次替换数量
    let replacementStats = { image: 0, video: 0 };

    for (const match of matches) {
        const originalTag = match[0];
        if (originalTag.includes('src=') || originalTag.includes('src =')) continue;

        // 提取 Prompt
        let rawPrompt = (match[2] || "").trim();
        let rawExtraParams = match[1] || "";

        if (!rawPrompt && match[1] && !match[0].includes('light_intensity') && !match[0].includes('videoParams')) {
            rawPrompt = match[1].trim();
            rawExtraParams = match[2] || "";
        }

        if (!rawPrompt) continue;

        const promptHash = simpleHash(normalizePrompt(rawPrompt));

        // 【逻辑 A：缓存回填】
        // 如果 onlyTrigger 为 true (流式传输中)，我们跳过替换，防止闪烁
        // 只有当 onlyTrigger 为 false (结束时或手动触发) 才执行替换
        if (!onlyTrigger && generatedCache.has(promptHash)) {
            const cachedMediaTag = generatedCache.get(promptHash);
            currentMessageText = currentMessageText.replace(originalTag, cachedMediaTag);
            contentModified = true;
            
            // 统计
            if (cachedMediaTag.includes('<video')) replacementStats.video++;
            else replacementStats.image++;
            
            continue; 
        }

        // 【逻辑 B：并发与冷却控制】
        if (processingHashes.has(promptHash)) continue;

        const now = Date.now();
        if (promptHistory.has(promptHash)) {
            const lastGenTime = promptHistory.get(promptHash);
            if (now - lastGenTime < PROMPT_COOLDOWN_MS) continue;
        }

        // 锁定
        processingHashes.add(promptHash);
        promptHistory.set(promptHash, now);

        // --- 开始异步生成 (后台任务) ---
        (async () => {
            let timer;
            let seconds = 0;
            try {
                let finalPrompt = rawPrompt;
                
                // 参数处理
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
                
                // 【Loading 占位符 - 倒计时通知】
                const baseText = `⏳ 生成 ${mediaTypeText} (${rawPrompt.substring(0, 10)}...)...`;
                let toast = toastr.info(`${baseText} ${seconds}s`, '', toastrOptions);

                timer = setInterval(() => {
                    seconds++;
                    const $toastElement = $(`.toast-message:contains("${baseText}")`).closest('.toast');
                    if ($toastElement.length) $toastElement.find('.toast-message').text(`${baseText} ${seconds}s`);
                    else clearInterval(timer);
                }, 1000);

                // 调用 SD
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

                    // 写入缓存
                    generatedCache.set(promptHash, mediaTag);

                    // 【核心逻辑：迟到的图片更新】
                    // 如果流式传输已经结束 (isStreamActive === false)，
                    // 说明图片生成比文字慢，现在需要主动刷新界面把图片贴上去。
                    // 传入 onlyTrigger=false 允许替换。
                    if (!isStreamActive) {
                        await processMessageContent(true, false); 
                        await eventSource.emit(event_types.MESSAGE_UPDATED, messageIndex);
                        if (isFinal) {
                            const finalContext = getContext();
                            await finalContext.saveChat();
                        }
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

    // 【DOM 更新】
    // 只有在非 onlyTrigger 模式下（即流式结束或手动更新时），且内容确实发生变化才更新
    if (!onlyTrigger && contentModified) {
        message.mes = currentMessageText;
        updateMessageBlock(messageIndex, message);

        // 【成功提示】
        // 汇总本次替换的数量和类型
        let successMsgParts = [];
        if (replacementStats.image > 0) successMsgParts.push(`${replacementStats.image} 张图片`);
        if (replacementStats.video > 0) successMsgParts.push(`${replacementStats.video} 个视频`);
        
        if (successMsgParts.length > 0) {
            toastr.success(`替换完成: ${successMsgParts.join(', ')}`);
        }
    }
}

// --- 事件监听 ---

const triggerFinalCheck = () => {
    if (finalCheckTimer) clearTimeout(finalCheckTimer);
    finalCheckTimer = setTimeout(() => {
        // 最终检查：流式结束，传入 onlyTrigger=false，允许替换所有已生成的图片
        processMessageContent(true, false);
    }, 300);
};

// 1. 生成开始
eventSource.on(event_types.GENERATION_STARTED, () => {
    realStreamingDetected = false;
    processingHashes.clear();
    
    if (!extension_settings[extensionName]?.streamGeneration) return;

    const context = getContext();
    if (!context.chat || context.chat.length === 0) return;
    
    isStreamActive = true;
    if (streamInterval) clearInterval(streamInterval);
    
    // 启动高频轮询
    streamInterval = setInterval(() => {
        if (!isStreamActive) { clearInterval(streamInterval); return; }
        
        // 【核心修改】：传入 onlyTrigger=true
        // 意思是：快去后台生成图片，但不要动界面！保持静默！
        processMessageContent(false, true); 
    }, 500); // 频率提高到 0.5秒，因为不会闪烁了，越快越好
});

eventSource.on(event_types.STREAM_TOKEN_RECEIVED, () => {
    realStreamingDetected = true;
});

// 2. 生成结束
const onGenerationFinished = async () => {
    if (streamInterval) { clearInterval(streamInterval); streamInterval = null; }
    isStreamActive = false;
    
    pruneOldPrompts();
    triggerFinalCheck(); // 这里会触发一次最终的统一替换
};

eventSource.on(event_types.GENERATION_ENDED, onGenerationFinished);
eventSource.on(event_types.GENERATION_STOPPED, onGenerationFinished);

// 3. 消息接收 (非流式/加载时)
eventSource.on(event_types.MESSAGE_RECEIVED, async () => {
    pruneOldPrompts();
    // 非流式直接允许替换
    await processMessageContent(true, false);
});
