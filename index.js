// 媒体自动生成插件主脚本 (修复流式可见性与并发重复问题版)
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
let generationTimer = null;
let domObserver = null;

// 【关键状态库】
const processingTags = new Set(); // 正在生成的锁 (防止并发重复)
const generatedCache = new Map(); // 缓存: 归一化Key -> 生成好的HTML
const failedTags = new Set();     // 失败黑名单
let currentProcessingIndex = -1;

const defaultSettings = {
    mediaType: 'disabled',
    imageRegex: '/<img\\b(?:(?:(?!\\bprompt\\b)[^>])*\\blight_intensity\\s*=\\s*"([^"]*)")?(?:(?!\\bprompt\\b)[^>])*\\bprompt\\s*=\\s*"([^"]*)"[^>]*>/gi',
    videoRegex: '/<video\b(?:(?:(?!\bprompt\b)[^>])*\bvideoParams\s*=\s*"([^"]*)")?(?:(?!\bprompt\b)[^>])*\bprompt\s*=\s*"([^"]*)"[^>]*>/gi',
    style: 'width:auto;height:auto',
    streamGeneration: false,
};

// 工具：转义 HTML 实体 (用于在 DOM 中查找被转义的标签)
function escapeHtmlForMatcher(value) {
    if (typeof value !== 'string') return '';
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// 工具：生成唯一 Key (去除空格，防止 Markdown 格式化导致认为是新标签)
function getNormalizedKey(tagString) {
    return tagString.replace(/\s+/g, '').trim();
}

function escapeHtmlAttribute(value) {
    if (typeof value !== 'string') return '';
    return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// --- DOM 观察者 (修复可见性核心) ---
function startDomObserver() {
    if (domObserver) return;
    const chatContainer = document.querySelector('#chat');
    if (!chatContainer) return;

    domObserver = new MutationObserver((mutations) => {
        const lastMessageText = chatContainer.querySelector('.last-message .mes_text');
        if (!lastMessageText) return;

        let htmlContent = lastMessageText.innerHTML;
        let hasChanges = false;

        // 遍历缓存进行替换
        generatedCache.forEach((mediaData) => {
            const { originalTag, mediaTag } = mediaData;
            
            // 1. 尝试匹配原始标签 (以防 ST 渲染了 raw HTML)
            if (htmlContent.includes(originalTag)) {
                htmlContent = htmlContent.split(originalTag).join(mediaTag);
                hasChanges = true;
            }
            
            // 2. 【关键修复】尝试匹配转义后的标签 (ST 流式传输常见情况: <img...> 变成了 &lt;img...&gt;)
            const escapedTag = escapeHtmlForMatcher(originalTag);
            if (htmlContent.includes(escapedTag)) {
                htmlContent = htmlContent.split(escapedTag).join(mediaTag);
                hasChanges = true;
            }
        });

        // 只有真正变化时才写入 DOM
        if (hasChanges) {
            lastMessageText.innerHTML = htmlContent;
        }
    });

    domObserver.observe(chatContainer, { childList: true, subtree: true, characterData: true });
    console.log(`[${extensionName}] 防闪烁 DOM 观察者已启动`);
}

function stopDomObserver() {
    if (domObserver) {
        domObserver.disconnect();
        domObserver = null;
        console.log(`[${extensionName}] 防闪烁 DOM 观察者已停止`);
    }
}

// --- 核心生成逻辑 ---

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
        // 【关键修复】使用归一化 Key，忽略空格差异
        const uniqueKey = getNormalizedKey(originalTag); 

        // 1. 缓存检查
        if (generatedCache.has(uniqueKey)) {
            // 如果是最终状态，确保数据被固化到 ST 数据层
            if (isFinal && message.mes.includes(originalTag)) {
                const { mediaTag } = generatedCache.get(uniqueKey);
                console.log(`[${extensionName}] 最终固化: ${uniqueKey.substring(0, 10)}...`);
                message.mes = message.mes.replace(originalTag, mediaTag);
                updateMessageBlock(messageIndex, message);
                await context.saveChat();
            }
            continue;
        }

        // 2. 并发锁检查
        if (processingTags.has(uniqueKey)) continue;

        // 3. 失败检查
        if (failedTags.has(uniqueKey)) continue;

        // --- 开始生成 ---
        processingTags.add(uniqueKey);
        
        (async () => {
            let timer;
            let seconds = 0;
            
            try {
                // 解析参数 (保持原有逻辑)
                let finalPrompt = '';
                let originalPrompt = '';
                let originalVideoParams = '';
                let originalLightIntensity = '';

                if (mediaType === 'video') {
                    originalVideoParams = typeof match?.[1] === 'string' ? match[1] : '';
                    originalPrompt = typeof match?.[2] === 'string' ? match[2] : '';
                    if (originalVideoParams) {
                        const p = originalVideoParams.split(',');
                        if (p.length === 3) finalPrompt = `{{setvar::videoFrameCount::${p[0]}}}{{setvar::videoWidth::${p[1]}}}{{setvar::videoHeight::${p[2]}}}${originalPrompt}`;
                        else finalPrompt = originalPrompt;
                    } else finalPrompt = originalPrompt;
                } else {
                    originalLightIntensity = typeof match?.[1] === 'string' ? match[1] : '';
                    originalPrompt = typeof match?.[2] === 'string' ? match[2] : '';
                    if (originalLightIntensity) {
                        const i = originalLightIntensity.split(',').map(s=>s.trim());
                        if (i.length === 2) finalPrompt = `{{setvar::light_intensity::${i[0]}}}{{setvar::sunshine_intensity::${i[1]}}}${originalPrompt}`;
                        else finalPrompt = originalPrompt;
                    } else finalPrompt = originalPrompt;
                }
                
                if (!finalPrompt.trim()) throw new Error("Empty prompt");

                // UI 提示
                const toastrOptions = { timeOut: 0, extendedTimeOut: 0, closeButton: true };
                let toast = toastr.info(`生成中... 0s`, '', toastrOptions);
                timer = setInterval(() => {
                    seconds++;
                    const $t = $(`.toast-message:contains("生成中")`).closest('.toast');
                    if ($t.length) $t.find('.toast-message').text(`生成中... ${seconds}s`);
                    else clearInterval(timer);
                }, 1000);

                // 调用 API
                const result = await SlashCommandParser.commands['sd'].callback({ quiet: 'true' }, finalPrompt);
                
                if (typeof result === 'string' && result.trim().length > 0) {
                    const style = extension_settings[extensionName].style || '';
                    const url = escapeHtmlAttribute(result);
                    const prm = originalPrompt; 
                    
                    let mediaTag;
                    if (mediaType === 'video') {
                        const vp = originalVideoParams ? escapeHtmlAttribute(originalVideoParams) : '';
                        mediaTag = `<video src="${url}" ${originalVideoParams ? `videoParams="${vp}"` : ''} prompt="${prm}" style="${style}" loop controls autoplay muted/>`;
                    } else {
                        const li = originalLightIntensity ? escapeHtmlAttribute(originalLightIntensity) : '0';
                        mediaTag = `<img src="${url}" light_intensity="${li}" prompt="${prm}" style="${style}" onclick="window.open(this.src)" />`;
                    }
                    
                    // 【成功】存入缓存 (存储完整对象以便 Observer 使用)
                    generatedCache.set(uniqueKey, {
                        originalTag: originalTag, // 保存原始标签用于 replacement
                        mediaTag: mediaTag
                    });
                    
                    console.log(`[${extensionName}] 生成成功: ${uniqueKey.substring(0, 10)}`);

                    // 实时更新逻辑：
                    // 如果流式已结束 (最后一张图生成慢)，或者是第一次生成成功，我们手动尝试一次 updateMessageBlock
                    // Observer 也会同时工作，双重保险
                    if (!isStreamActive || isFinal) {
                         const currCtx = getContext();
                         const currMsg = currCtx.chat[messageIndex];
                         if (currMsg.mes.includes(originalTag)) {
                             currMsg.mes = currMsg.mes.replace(originalTag, mediaTag);
                             updateMessageBlock(messageIndex, currMsg);
                             if (isFinal) await currCtx.saveChat();
                         }
                    }
                } else {
                    throw new Error("API returned empty result");
                }
                
                clearInterval(timer);
                toastr.clear(toast);
                toastr.success(`生成完成`);

            } catch (error) {
                console.error(`[${extensionName}] 生成失败:`, error);
                clearInterval(timer);
                toastr.clear();
                toastr.error(`生成失败`);
                failedTags.add(uniqueKey); // 加入熔断黑名单
            } finally {
                processingTags.delete(uniqueKey); // 释放锁
            }
        })();
    }
}

// --- 设置和初始化 (无变化) ---

async function createSettings(settingsHtml) {
    if (!$('#media_auto_generation_container').length) {
        $('#extensions_settings2').append('<div id="media_auto_generation_container" class="extension_container"></div>');
    }
    $('#media_auto_generation_container').empty().append(settingsHtml);

    $('#mediaType').on('change', function () {
        extension_settings[extensionName].mediaType = $(this).val();
        updateUI(); saveSettingsDebounced();
    });
    $('#image_regex').on('input', function () { extension_settings[extensionName].imageRegex = $(this).val(); saveSettingsDebounced(); });
    $('#video_regex').on('input', function () { extension_settings[extensionName].videoRegex = $(this).val(); saveSettingsDebounced(); });
    $('#media_style').on('input', function () { extension_settings[extensionName].style = $(this).val(); saveSettingsDebounced(); });
    $('#stream_generation').on('change', function () { extension_settings[extensionName].streamGeneration = $(this).prop('checked'); saveSettingsDebounced(); });
    updateUI();
}

function updateUI() {
    if ($('#mediaType').length) {
        $('#mediaType').val(extension_settings[extensionName].mediaType);
        $('#image_regex').val(extension_settings[extensionName].imageRegex);
        $('#video_regex').val(extension_settings[extensionName].videoRegex);
        $('#media_style').val(extension_settings[extensionName].style);
        $('#stream_generation').prop('checked', extension_settings[extensionName].streamGeneration ?? false);
    }
}

function loadSettings() {
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    if (Object.keys(extension_settings[extensionName]).length === 0) Object.assign(extension_settings[extensionName], defaultSettings);
    else for (const key in defaultSettings) if (extension_settings[extensionName][key] === undefined) extension_settings[extensionName][key] = defaultSettings[key];
    updateUI();
}

// --- 事件监听 ---

eventSource.on(event_types.GENERATION_STARTED, () => {
    if (!extension_settings[extensionName]?.streamGeneration) return;
    const context = getContext();
    if (!context.chat || context.chat.length === 0) return;
    
    const newIndex = context.chat.length - 1;

    // 检测到新消息，重置状态
    if (newIndex !== currentProcessingIndex) {
        processingTags.clear();
        generatedCache.clear();
        failedTags.clear();
        currentProcessingIndex = newIndex;
    }

    isStreamActive = true;
    startDomObserver(); // 启动 Observer

    // 启动低频扫描 (0.5秒一次)，只负责触发生成 API
    if (generationTimer) clearInterval(generationTimer);
    generationTimer = setInterval(() => {
        if (!isStreamActive) {
            clearInterval(generationTimer); return;
        }
        processMessageContent(false);
    }, 500); // 加快检查频率，避免连续出图时漏掉
});

const onGenerationFinished = async () => {
    if (generationTimer) { clearInterval(generationTimer); generationTimer = null; }
    if (isStreamActive) {
        isStreamActive = false;
        // 延迟长一点，确保最后一张图能赶上
        setTimeout(() => {
            stopDomObserver();
            processMessageContent(true); // 最终固化
        }, 1000);
    }
};

eventSource.on(event_types.GENERATION_ENDED, onGenerationFinished);
eventSource.on(event_types.GENERATION_STOPPED, onGenerationFinished);

eventSource.on(event_types.MESSAGE_RECEIVED, async () => {
    const context = getContext();
    if (!context.chat || context.chat.length === 0) return;
    const newIndex = context.chat.length - 1;

    if (!extension_settings[extensionName]?.streamGeneration) {
        if (newIndex !== currentProcessingIndex) {
            processingTags.clear();
            generatedCache.clear();
            failedTags.clear();
            currentProcessingIndex = newIndex;
        }
    }
    // 非流式模式下直接处理
    await processMessageContent(true);
});

$(function () {
    (async function () {
        const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
        $('#extensionsMenu').append(`<div id="auto_generation" class="list-group-item flex-container flexGap5"><div class="fa-solid fa-film"></div><span data-i18n="Media Auto Generation">Media Auto Generation</span></div>`);
        $('#auto_generation').on('click', function() {
            const extensionsDrawer = $('#extensions-settings-button .drawer-toggle');
            if ($('#rm_extensions_block').hasClass('closedDrawer')) extensionsDrawer.trigger('click');
            setTimeout(() => {
                const container = $('#media_auto_generation_container');
                if (container.length) {
                    $('#rm_extensions_block').animate({ scrollTop: container.offset().top - $('#rm_extensions_block').offset().top + $('#rm_extensions_block').scrollTop() }, 500);
                    const dh = container.find('.inline-drawer-header');
                    const dc = container.find('.inline-drawer-content');
                    if (dc.is(':hidden')) dh.trigger('click');
                }
            }, 500);
        });
        loadSettings();
        await createSettings(settingsHtml);
        $('#extensions-settings-button').on('click', function () { setTimeout(updateUI, 200); });
    })();
});
