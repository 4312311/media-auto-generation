// 媒体自动生成插件主脚本 - 修复版 (防抖+强制回填)

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
let currentProcessingIndex = -1;
let realStreamingDetected = false;
let finalCheckTimer = null;

// 1. 生成结果缓存
// Key: Prompt Hash, Value: 完整的HTML标签 (<img src="..." ...>)
const generatedCache = new Map();

// 2. 历史记录 (冷却锁)
// Key: Prompt Hash, Value: 上次生成的时间戳
const promptHistory = new Map();

// 3. 并发处理锁 (内存锁)
// Key: Prompt Hash. 存在于此集合中表示正在生成中，绝对禁止再次触发
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
 * 去除首尾空格，将连续空格合并为一个，转小写（可选，视模型敏感度而定，这里为了缓存命中率建议转小写）
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
    let deletedCount = 0;
    for (const [hash, timestamp] of promptHistory.entries()) {
        if (now - timestamp > PROMPT_COOLDOWN_MS) {
            promptHistory.delete(hash);
            // 同时清理缓存，防止内存无限膨胀
            generatedCache.delete(hash);
            deletedCount++;
        }
    }
    // if (deletedCount > 0) console.log(`[${extensionName}] 清理了 ${deletedCount} 个过期记录`);
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

// --- 核心处理逻辑 (修复版) ---

async function processMessageContent(isFinal = false) {
    if (!extension_settings[extensionName] || extension_settings[extensionName].mediaType === 'disabled') return;

    const context = getContext();
    const messageIndex = context.chat.length - 1;
    const message = context.chat[messageIndex];

    if (!message || message.is_user || !message.mes) return;

    const mediaType = extension_settings[extensionName].mediaType;
    const regexStr = mediaType === 'image' ? extension_settings[extensionName].imageRegex : extension_settings[extensionName].videoRegex;
    if (!regexStr) return;

    const mediaTagRegex = regexFromString(regexStr);
    
    // 使用 matchAll 获取所有匹配项
    const matches = [...message.mes.matchAll(mediaTagRegex)];
    if (matches.length === 0) return;

    let contentModified = false;
    let currentMessageText = message.mes; // 在本地副本上操作

    for (const match of matches) {
        const originalTag = match[0];

        // 如果已经是带 src 的完整标签，通常跳过。
        // 但为了防止流式回滚，如果它符合我们的正则且包含 src，我们暂时不管它。
        if (originalTag.includes('src=') || originalTag.includes('src =')) continue;

        // 提取 Prompt
        let rawPrompt = (match[2] || "").trim();
        let rawExtraParams = match[1] || ""; // light_intensity 或 videoParams

        // 兼容性提取 (如果正则组顺序不同)
        if (!rawPrompt && match[1] && !match[0].includes('light_intensity') && !match[0].includes('videoParams')) {
            rawPrompt = match[1].trim();
            rawExtraParams = match[2] || "";
        }

        if (!rawPrompt) continue;

        // 【核心修复1】计算 Hash Key
        const promptHash = simpleHash(normalizePrompt(rawPrompt));

        // 【核心修复2】缓存回填 (优先权最高)
        // 只要缓存里有，说明生成过，强制替换文本，防止流式刷新导致图片消失
        if (generatedCache.has(promptHash)) {
            const cachedMediaTag = generatedCache.get(promptHash);
            // 只替换当前的 originalTag
            currentMessageText = currentMessageText.replace(originalTag, cachedMediaTag);
            contentModified = true;
            // 继续处理下一个标签
            continue; 
        }

        // 【核心修复3】并发控制
        // 如果正在处理这个 Hash，跳过
        if (processingHashes.has(promptHash)) continue;

        // 【核心修复4】冷却检查
        const now = Date.now();
        if (promptHistory.has(promptHash)) {
            const lastGenTime = promptHistory.get(promptHash);
            if (now - lastGenTime < PROMPT_COOLDOWN_MS) {
                // 还在冷却中，跳过
                continue;
            }
        }

        // 【核心修复5】同步加锁 (Critical Section)
        // 在 await 之前立即加锁，防止后续的流式 token 再次触发
        processingHashes.add(promptHash);
        promptHistory.set(promptHash, now);

        // --- 开始异步生成 ---
        (async () => {
            let timer;
            let seconds = 0;
            try {
                let finalPrompt = rawPrompt;
                
                // 处理参数 (Video / Image)
                if (mediaType === 'video') {
                    if (rawExtraParams && rawExtraParams.trim()) {
                        const params = rawExtraParams.split(',');
                        if (params.length === 3) {
                            const [frameCount, width, height] = params;
                            finalPrompt = `{{setvar::videoFrameCount::${frameCount}}}{{setvar::videoWidth::${width}}}{{setvar::videoHeight::${height}}}` + rawPrompt;
                        }
                    }
                } else {
                    // Image params
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
                const baseText = `生成 ${mediaTypeText} (${rawPrompt.substring(0, 10)}...)...`;
                let toast = toastr.info(`${baseText} ${seconds}s`, '', toastrOptions);

                timer = setInterval(() => {
                    seconds++;
                    const $toastElement = $(`.toast-message:contains("${baseText}")`).closest('.toast');
                    if ($toastElement.length) $toastElement.find('.toast-message').text(`${baseText} ${seconds}s`);
                    else clearInterval(timer);
                }, 1000);

                // 调用 ST 的 /sd 命令
                const result = await SlashCommandParser.commands['sd'].callback({ quiet: 'true' }, finalPrompt);

                clearInterval(timer);
                toastr.clear(toast);

                if (typeof result === 'string' && result.trim().length > 0) {
                    toastr.success(`成功生成 ${mediaTypeText}, 耗时 ${seconds}s`);
                    
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

                    // 主动触发一次更新，确保图片立刻显示
                    // 通过重新调用 processMessageContent，利用上方的缓存回填逻辑来更新 DOM
                    await processMessageContent(isFinal);
                    
                    // 通知 ST 消息已更新 (解决显示滞后)
                    await eventSource.emit(event_types.MESSAGE_UPDATED, messageIndex);
                    if (isFinal) {
                        const finalContext = getContext();
                        await finalContext.saveChat();
                    }
                } else {
                    // 返回空字符串视为失败
                     throw new Error("Empty result from SD");
                }

            } catch (error) {
                console.error(`[${extensionName}] Generation failed:`, error);
                if (timer) clearInterval(timer);
                toastr.error(`Media generation error: ${error}`);
                
                // 失败回滚：删除 History 记录，允许用户稍后重试（或修改 prompt 后重试）
                promptHistory.delete(promptHash);
            } finally {
                // 无论成功失败，一定要释放内存锁
                processingHashes.delete(promptHash);
            }
        })();
    }

    // 如果我们在这一轮同步循环中修改了文本（回填了缓存），更新 DOM
    if (contentModified) {
        message.mes = currentMessageText;
        updateMessageBlock(messageIndex, message);
    }
}

// --- 事件监听 ---

const triggerFinalCheck = () => {
    if (finalCheckTimer) clearTimeout(finalCheckTimer);
    finalCheckTimer = setTimeout(() => {
        processMessageContent(true);
        
        const pluginStreamSetting = extension_settings[extensionName]?.streamGeneration;
        if (pluginStreamSetting && !realStreamingDetected) {
             // console.warn("Stream setting mismatch (Plugin ON, ST OFF)");
        } else if (!pluginStreamSetting && realStreamingDetected) {
            alert("【Media Auto Gen 警告】\n检测到SillyTavern正在流式传输，但本插件「流式生成」未开启。\n建议开启插件的 Stream Generation 以获得最佳体验。");
        }
    }, 300);
};

// 1. 生成开始
eventSource.on(event_types.GENERATION_STARTED, () => {
    realStreamingDetected = false;

    // 清空内存锁，防止上一轮意外卡死的任务阻塞这一轮
    processingHashes.clear();
    
    // 【重要】不要清空 generatedCache，以便在“重新生成”时复用图片
    // 只有当 index 变化时才考虑重置上下文，但在这里我们依赖 Hash 即使换了 index 也能复用
    
    if (!extension_settings[extensionName]?.streamGeneration) return;

    const context = getContext();
    if (!context.chat || context.chat.length === 0) return;
    
    isStreamActive = true;
    if (streamInterval) clearInterval(streamInterval);
    
    // 启动轮询，实时检测流式输出中的标签
    streamInterval = setInterval(() => {
        if (!isStreamActive) { clearInterval(streamInterval); return; }
        processMessageContent(false);
    }, 2000);
});

eventSource.on(event_types.STREAM_TOKEN_RECEIVED, () => {
    realStreamingDetected = true;
    // 可以在这里增加高频检测，但为了性能通常保留 interval 或仅在这里做标记
});

// 2. 生成结束
const onGenerationFinished = async () => {
    if (streamInterval) { clearInterval(streamInterval); streamInterval = null; }
    isStreamActive = false;
    
    // 清理过期数据
    pruneOldPrompts();
    
    triggerFinalCheck();
};

eventSource.on(event_types.GENERATION_ENDED, onGenerationFinished);
eventSource.on(event_types.GENERATION_STOPPED, onGenerationFinished);

// 3. 消息接收 (用于非流式或加载聊天记录时)
eventSource.on(event_types.MESSAGE_RECEIVED, async () => {
    // 清理过期数据
    pruneOldPrompts();
    await processMessageContent(true);
});
