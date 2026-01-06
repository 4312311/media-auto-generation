// 媒体自动生成插件主脚本 (最终防重稳健版)
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
const generatedCache = new Map(); // 生成成功的缓存 (用于显示)
const failedTags = new Set();     // 生成失败的黑名单 (防止错误循环)
let currentProcessingIndex = -1;

const defaultSettings = {
    mediaType: 'disabled',
    imageRegex: '/<img\\b(?:(?:(?!\\bprompt\\b)[^>])*\\blight_intensity\\s*=\\s*"([^"]*)")?(?:(?!\\bprompt\\b)[^>])*\\bprompt\\s*=\\s*"([^"]*)"[^>]*>/gi',
    videoRegex: '/<video\b(?:(?:(?!\bprompt\b)[^>])*\bvideoParams\s*=\s*"([^"]*)")?(?:(?!\bprompt\b)[^>])*\bprompt\s*=\s*"([^"]*)"[^>]*>/gi',
    style: 'width:auto;height:auto',
    streamGeneration: false,
};

function escapeHtmlAttribute(value) {
    if (typeof value !== 'string') return '';
    return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// --- DOM 观察者 (无闪烁显示层) ---
function startDomObserver() {
    if (domObserver) return;
    const chatContainer = document.querySelector('#chat');
    if (!chatContainer) return;

    domObserver = new MutationObserver((mutations) => {
        const lastMessageText = chatContainer.querySelector('.last-message .mes_text');
        if (!lastMessageText) return;

        let htmlContent = lastMessageText.innerHTML;
        let hasChanges = false;

        generatedCache.forEach((mediaTag, originalTag) => {
            // 只要 DOM 里包含原始标签，就瞬间替换
            if (htmlContent.includes(originalTag)) {
                htmlContent = htmlContent.split(originalTag).join(mediaTag);
                hasChanges = true;
            }
        });

        if (hasChanges) lastMessageText.innerHTML = htmlContent;
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
        const uniqueKey = originalTag.trim(); // 使用 trim 后的标签作为唯一键

        // 【防重检查 1】: 是否已经生成成功？
        if (generatedCache.has(uniqueKey)) {
            // 只有在最终结束时，才执行数据固化（保存到 chat）
            if (isFinal && message.mes.includes(uniqueKey)) {
                const cachedMediaTag = generatedCache.get(uniqueKey);
                console.log(`[${extensionName}] 最终固化数据: ${uniqueKey.substring(0, 10)}...`);
                message.mes = message.mes.replace(uniqueKey, cachedMediaTag);
                updateMessageBlock(messageIndex, message);
                await context.saveChat();
            }
            continue; // 跳过生成
        }

        // 【防重检查 2】: 是否正在生成中？
        if (processingTags.has(uniqueKey)) {
            // 正在生成中，直接跳过，等待之前的请求完成
            continue; 
        }

        // 【防重检查 3】: 是否之前失败过？
        if (failedTags.has(uniqueKey)) {
            continue; // 之前报错了，不再尝试，防止无限报错循环
        }

        // --- 通过所有检查，开始生成 ---
        
        // 1. 立即上锁
        processingTags.add(uniqueKey);
        console.log(`[${extensionName}] 发起生成请求: ${uniqueKey.substring(0, 20)}...`);

        // 2. 异步执行生成 (IIFE)
        (async () => {
            let timer;
            let seconds = 0;
            
            try {
                // --- 解析参数 Start ---
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
                // --- 解析参数 End ---

                // UI 提示
                const toastrOptions = { timeOut: 0, extendedTimeOut: 0, closeButton: true };
                let toast = toastr.info(`正在生成... 0s`, '', toastrOptions);
                timer = setInterval(() => {
                    seconds++;
                    const $t = $(`.toast-message:contains("正在生成")`).closest('.toast');
                    if ($t.length) $t.find('.toast-message').text(`正在生成... ${seconds}s`);
                    else clearInterval(timer);
                }, 1000);

                // 调用 API
                const result = await SlashCommandParser.commands['sd'].callback({ quiet: 'true' }, finalPrompt);
                
                if (typeof result === 'string' && result.trim().length > 0) {
                    // 构建 HTML
                    const style = extension_settings[extensionName].style || '';
                    const url = escapeHtmlAttribute(result);
                    const prm = originalPrompt; // 不转义 prompt 用于显示属性，或按需转义
                    
                    let mediaTag;
                    if (mediaType === 'video') {
                        const vp = originalVideoParams ? escapeHtmlAttribute(originalVideoParams) : '';
                        mediaTag = `<video src="${url}" ${originalVideoParams ? `videoParams="${vp}"` : ''} prompt="${prm}" style="${style}" loop controls autoplay muted/>`;
                    } else {
                        const li = originalLightIntensity ? escapeHtmlAttribute(originalLightIntensity) : '0';
                        mediaTag = `<img src="${url}" light_intensity="${li}" prompt="${prm}" style="${style}" onclick="window.open(this.src)" />`;
                    }
                    
                    // 【成功】存入缓存 -> Observer 会自动上屏
                    generatedCache.set(uniqueKey, mediaTag);
                    console.log(`[${extensionName}] 生成成功并缓存`);

                    // 边缘情况处理：如果流式已经结束（isStreamActive为false），Observer可能不会再刷新DOM了
                    // 或者这是最后一次检查 (isFinal)，我们需要手动更新数据
                    if (!isStreamActive || isFinal) {
                         const currCtx = getContext();
                         const currMsg = currCtx.chat[messageIndex];
                         if (currMsg.mes.includes(uniqueKey)) {
                             currMsg.mes = currMsg.mes.replace(uniqueKey, mediaTag);
                             updateMessageBlock(messageIndex, currMsg);
                             if (isFinal) await currCtx.saveChat();
                         }
                    }
                } else {
                    throw new Error("API returned empty result");
                }
                
                clearInterval(timer);
                toastr.clear(toast);
                toastr.success(`生成完成 (${seconds}s)`);

            } catch (error) {
                console.error(`[${extensionName}] 生成失败:`, error);
                clearInterval(timer);
                toastr.clear();
                toastr.error(`生成失败: ${error.message}`);
                
                // 【失败熔断】加入失败名单，避免下次轮询重复尝试
                failedTags.add(uniqueKey);
                
            } finally {
                // 【解锁】无论成功失败，都必须释放锁
                processingTags.delete(uniqueKey);
            }
        })();
    }
}

// --- 设置和初始化 (保持精简) ---

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

    // 新的一条消息，重置所有缓存和状态
    if (newIndex !== currentProcessingIndex) {
        processingTags.clear();
        generatedCache.clear();
        failedTags.clear(); // 清空失败记录
        currentProcessingIndex = newIndex;
    }

    isStreamActive = true;
    startDomObserver();

    // 启动低频扫描 (1秒一次)，只负责触发生成
    if (generationTimer) clearInterval(generationTimer);
    generationTimer = setInterval(() => {
        if (!isStreamActive) {
            clearInterval(generationTimer); return;
        }
        processMessageContent(false);
    }, 1000);
});

const onGenerationFinished = async () => {
    if (generationTimer) { clearInterval(generationTimer); generationTimer = null; }
    if (isStreamActive) {
        isStreamActive = false;
        setTimeout(() => {
            stopDomObserver();
            processMessageContent(true); // 最终固化
        }, 500);
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
