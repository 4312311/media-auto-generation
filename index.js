// 媒体自动生成插件主脚本 - 死锁修复版
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
const processingTags = new Set();
// 缓存：HTML代码
const generatedCache = new Map(); 
// 历史：本轮对话已处理过的Prompt (死锁用)
const currentSessionPrompts = new Set();

let currentProcessingIndex = -1;
let realStreamingDetected = false;
let finalCheckTimer = null;

function escapeHtmlAttribute(value) {
    if (typeof value !== 'string') return '';
    return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const defaultSettings = {
    mediaType: 'disabled',
    imageRegex: '/<img\\b(?:(?:(?!\\bprompt\\b)[^>])*\\blight_intensity\\s*=\\s*"([^"]*)")?(?:(?!\\bprompt\\b)[^>])*\\bprompt\\s*=\\s*"([^"]*)"[^>]*>/gi',
    videoRegex: '/<video\b(?:(?:(?!\bprompt\b)[^>])*\bvideoParams\s*=\s*"([^"]*)")?(?:(?!\bprompt\b)[^>])*\bprompt\s*=\s*"([^"]*)"[^>]*>/gi',
    style: 'width:auto;height:auto',
    streamGeneration: false, 
};

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

/**
 * 核心处理逻辑
 */
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
    let matches;
    if (mediaTagRegex.global) {
        matches = [...message.mes.matchAll(mediaTagRegex)];
    } else {
        const singleMatch = message.mes.match(mediaTagRegex);
        matches = singleMatch ? [singleMatch] : [];
    }
    
    if (matches.length === 0) return;

    for (const match of matches) {
        const originalTag = match[0];
        // 1. 绝对防御：如果已有 src=，跳过
        if (originalTag.includes('src=') || originalTag.includes('src =')) continue;
        
        const uniqueKey = originalTag.trim();

        // 2. 缓存回填 (优先尝试恢复图片)
        if (generatedCache.has(uniqueKey)) {
            const cachedMediaTag = generatedCache.get(uniqueKey);
            // 双重检查：只有当文本里确实还是原始标签时才替换
            if (message.mes.includes(uniqueKey)) {
                console.log(`[${extensionName}] [DEBUG] 缓存命中，恢复显示: ${uniqueKey.substring(0, 15)}...`);
                message.mes = message.mes.replace(uniqueKey, cachedMediaTag);
                updateMessageBlock(messageIndex, message);
                if (isFinal) await context.saveChat();
            }
            continue;
        }

        // 3. 并发保护
        if (processingTags.has(uniqueKey)) continue;

        // 4. 【死锁检查】 Prompt 幂等性
        // 只要这个 Prompt 在本轮对话中出现过，无论现在文本变成了什么样，都禁止再次生成
        let extractedPrompt = (match[2] || "").trim();
        if (!extractedPrompt && match[1] && !match[0].includes('light_intensity') && !match[0].includes('videoParams')) {
             extractedPrompt = match[1].trim();
        }
        
        if (extractedPrompt) {
            if (currentSessionPrompts.has(extractedPrompt)) {
                // 如果在历史里，但没命中上面的缓存(generatedCache)，说明可能出了怪事(如格式微变)
                // 但为了不重复生图，这里必须直接 abort
                console.log(`[${extensionName}] [死锁拦截] 阻止重复生成: ${extractedPrompt.substring(0, 10)}...`);
                continue; 
            }
            // 加入历史记录
            currentSessionPrompts.add(extractedPrompt);
        }

        processingTags.add(uniqueKey);
        
        // 生成逻辑
        (async () => {
            let timer;
            let seconds = 0;
            try {
                let originalPrompt = '';
                let originalVideoParams = '';
                let originalLightIntensity = '';
                let finalPrompt = '';

                if (mediaType === 'video') {
                    originalVideoParams = typeof match?.[1] === 'string' ? match[1] : '';
                    originalPrompt = typeof match?.[2] === 'string' ? match[2] : '';
                    if (originalVideoParams && originalVideoParams.trim()) {
                        const params = originalVideoParams.split(',');
                        if (params.length === 3) {
                            const [frameCount, width, height] = params;
                            finalPrompt = `{{setvar::videoFrameCount::${frameCount}}}{{setvar::videoWidth::${width}}}{{setvar::videoHeight::${height}}}` + originalPrompt;
                        } else {
                            finalPrompt = originalPrompt;
                        }
                    } else {
                        finalPrompt = originalPrompt;
                    }
                } else {
                    originalLightIntensity = typeof match?.[1] === 'string' ? match[1] : '';
                    originalPrompt = typeof match?.[2] === 'string' ? match[2] : '';
                    let lightIntensity = 0;
                    let sunshineIntensity = 0;
                    if (originalLightIntensity && originalLightIntensity.trim()) {
                        const intensityArr = originalLightIntensity.split(',').map(item => item.trim());
                        if (intensityArr.length === 2) {
                            const parsedLight = parseFloat(intensityArr[0]);
                            const parsedSunshine = parseFloat(intensityArr[1]);
                            if (!isNaN(parsedLight)) lightIntensity = Math.round(parsedLight * 100) / 100;
                            if (!isNaN(parsedSunshine)) sunshineIntensity = Math.round(parsedSunshine * 100) / 100;
                            finalPrompt = `{{setvar::light_intensity::${lightIntensity}}}{{setvar::sunshine_intensity::${sunshineIntensity}}}` + originalPrompt;
                        } else {
                            finalPrompt = originalPrompt;
                        }
                    } else {
                        finalPrompt = originalPrompt;
                    }
                }
                
                if (!finalPrompt.trim()) {
                    processingTags.delete(uniqueKey);
                    if(extractedPrompt) currentSessionPrompts.delete(extractedPrompt);
                    return;
                }

                const mediaTypeText = mediaType === 'image' ? 'image' : 'video';
                const toastrOptions = { timeOut: 0, extendedTimeOut: 0, closeButton: true };
                const baseText = `生成 ${mediaTypeText} (${originalPrompt.substring(0, 10)}...)...`; 
                let toast = toastr.info(`${baseText} ${seconds}s`, '', toastrOptions);
                
                timer = setInterval(() => {
                    seconds++;
                    const $toastElement = $(`.toast-message:contains("${baseText}")`).closest('.toast');
                    if ($toastElement.length) $toastElement.find('.toast-message').text(`${baseText} ${seconds}s`);
                    else clearInterval(timer);
                }, 1000);

                const result = await SlashCommandParser.commands['sd'].callback({ quiet: 'true' }, finalPrompt);
                
                if (typeof result === 'string' && result.trim().length > 0) {
                    const style = extension_settings[extensionName].style || '';
                    const escapedUrl = escapeHtmlAttribute(result);
                    const escapedOriginalPrompt = originalPrompt;
                    
                    let mediaTag;
                    if (mediaType === 'video') {
                        const escapedVideoParams = originalVideoParams ? escapeHtmlAttribute(originalVideoParams) : '';
                        mediaTag = `<video src="${escapedUrl}" ${originalVideoParams ? `videoParams="${escapedVideoParams}"` : ''} prompt="${escapedOriginalPrompt}" style="${style}" loop controls autoplay muted/>`;
                    } else {
                        const escapedLightIntensity = originalLightIntensity ? escapeHtmlAttribute(originalLightIntensity) : '0';
                        mediaTag = `<img src="${escapedUrl}" ${originalLightIntensity ? `light_intensity="${escapedLightIntensity}"` : 'light_intensity="0"'} prompt="${escapedOriginalPrompt}" style="${style}" onclick="window.open(this.src)" />` ;
                    }
                    
                    generatedCache.set(uniqueKey, mediaTag);

                    const currentContext = getContext();
                    const currentMsg = currentContext.chat[messageIndex];

                    if (currentMsg.mes.includes(uniqueKey)) {
                        currentMsg.mes = currentMsg.mes.replace(uniqueKey, mediaTag);
                        updateMessageBlock(messageIndex, currentMsg);
                        await eventSource.emit(event_types.MESSAGE_UPDATED, messageIndex);
                        if (isFinal) await currentContext.saveChat();
                    }
                }

                clearInterval(timer);
                toastr.clear(toast);
                toastr.success(`成功生成 ${mediaTypeText}, 耗时 ${seconds}s`);

            } catch (error) {
                clearInterval(timer);
                toastr.error(`Media generation error: ${error}`);
                if (finalPrompt && extractedPrompt) currentSessionPrompts.delete(extractedPrompt);
            } finally {
                processingTags.delete(uniqueKey);
            }
        })();
    }
}

// --- 事件监听 ---

const triggerFinalCheck = () => {
    if (finalCheckTimer) clearTimeout(finalCheckTimer);
    finalCheckTimer = setTimeout(() => {
        processMessageContent(true);
        
        // 报警逻辑
        const pluginStreamSetting = extension_settings[extensionName]?.streamGeneration;
        if (pluginStreamSetting && !realStreamingDetected) {
            const context = getContext();
            if (context.chat && context.chat.length > 0) {
                 // 限制报警频率，避免烦人
                 console.warn("【Media Auto Gen】检测到开启了插件流式生成，但ST实际未流式传输。");
            }
        } else if (!pluginStreamSetting && realStreamingDetected) {
            alert("【Media Auto Gen 警告】\n检测到SillyTavern正在流式传输，但本插件「流式生成」未开启。\n建议开启插件的 Stream Generation 以获得最佳体验。");
        }
    }, 300);
};

// 1. 生成开始：这是唯一允许清空 Prompt 历史的地方！
eventSource.on(event_types.GENERATION_STARTED, () => {
    console.log(`[${extensionName}] GENERATION_STARTED - 清空 Prompt 锁`);
    realStreamingDetected = false;
    currentSessionPrompts.clear(); // <--- 只有这里清空！

    if (!extension_settings[extensionName]?.streamGeneration) return;

    const context = getContext();
    if (!context.chat || context.chat.length === 0) return;
    const newIndex = context.chat.length - 1;

    if (newIndex !== currentProcessingIndex) {
        processingTags.clear();
        generatedCache.clear();
        currentProcessingIndex = newIndex;
    }

    isStreamActive = true;
    if (streamInterval) clearInterval(streamInterval);
    streamInterval = setInterval(() => {
        if (!isStreamActive) { clearInterval(streamInterval); return; }
        processMessageContent(false);
    }, 2000);
});

eventSource.on(event_types.STREAM_TOKEN_RECEIVED, () => {
    realStreamingDetected = true;
});

// 2. 生成结束
const onGenerationFinished = async () => {
    if (streamInterval) { clearInterval(streamInterval); streamInterval = null; }
    isStreamActive = false;
    triggerFinalCheck();
};

eventSource.on(event_types.GENERATION_ENDED, onGenerationFinished);
eventSource.on(event_types.GENERATION_STOPPED, onGenerationFinished);

// 3. 消息接收
eventSource.on(event_types.MESSAGE_RECEIVED, async () => {
    const context = getContext();
    if (!context.chat || context.chat.length === 0) return;
    const newIndex = context.chat.length - 1;
    
    // 如果索引变了，说明换了条消息，清理缓存
    if (newIndex !== currentProcessingIndex) {
        processingTags.clear();
        generatedCache.clear();
        // currentSessionPrompts.clear(); // 【绝对禁止】在这里清空！这是bug的根源
        currentProcessingIndex = newIndex;
    }

    await processMessageContent(true);
});
