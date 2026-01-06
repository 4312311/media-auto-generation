// 媒体自动生成插件主脚本 - 调试增强版
import { extension_settings, getContext } from '../../../extensions.js';
import {
    saveSettingsDebounced,
    eventSource,
    event_types,
    updateMessageBlock,
} from '../../../../script.js';
import { regexFromString } from '../../../utils.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';

// 扩展名称和路径
const extensionName = 'media-auto-generation';
const extensionFolderPath = `/scripts/extensions/third-party/${extensionName}`;

// --- 调试与统计系统 ---
const LOG_PREFIX = '[MEDIA_GEN_DEBUG]'; // 过滤关键词

const debugStats = {
    eventsTriggered: 0,
    apiCalls: 0,
    cacheHits: 0,
    domReplacements: 0,
    scanCount: 0, // 扫描次数
    scanMatches: 0, // 匹配成功次数
    errors: 0
};

function resetStats() {
    debugStats.eventsTriggered = 0;
    debugStats.apiCalls = 0;
    debugStats.cacheHits = 0;
    debugStats.domReplacements = 0;
    debugStats.scanCount = 0;
    debugStats.scanMatches = 0;
    debugStats.errors = 0;
}

function debugLog(type, message, data = null) {
    const timestamp = new Date().toLocaleTimeString();
    const fullMessage = `${LOG_PREFIX} [${timestamp}] [${type}] ${message}`;
    
    switch(type) {
        case 'ERROR':
            console.error(fullMessage, data || '');
            debugStats.errors++;
            break;
        case 'STATS':
            console.group(`${LOG_PREFIX} === 统计报告 ===`);
            console.table(debugStats);
            console.groupEnd();
            break;
        default:
            // 默认打印普通日志
            console.log(fullMessage, data !== null ? data : '');
            break;
    }
}

// --- 全局状态 ---
let isStreamActive = false;
const processingTags = new Set(); 
const generatedCache = new Map(); 
let currentProcessingIndex = -1; 
let observer = null;

function escapeHtmlAttribute(value) {
    if (typeof value !== 'string') return '';
    return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const defaultSettings = {
    mediaType: 'disabled',
    // 默认正则，请确保 LLM 输出的格式与此匹配
    imageRegex: '/<img\\b(?:(?:(?!\\bprompt\\b)[^>])*\\blight_intensity\\s*=\\s*"([^"]*)")?(?:(?!\\bprompt\\b)[^>])*\\bprompt\\s*=\\s*"([^"]*)"[^>]*>/gi',
    videoRegex: '/<video\b(?:(?:(?!\bprompt\b)[^>])*\bvideoParams\s*=\s*"([^"]*)")?(?:(?!\bprompt\b)[^>])*\bprompt\s*=\s*"([^"]*)"[^>]*>/gi',
    style: 'width:auto;height:auto',
    streamGeneration: false,
};

// --- UI与设置 (保持精简) ---
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

// --- 核心逻辑：扫描与生成 ---

/**
 * 扫描文本，触发生成
 */
function scanAndProcessTags(textContent, triggerGeneration = true) {
    debugStats.scanCount++;
    
    // 1. 基础检查
    if (!extension_settings[extensionName] || extension_settings[extensionName].mediaType === 'disabled') {
        // debugLog('SCAN', '插件未启用或媒体类型为disabled'); // 过于频繁，注释掉
        return [];
    }

    // 2. 获取正则
    const mediaType = extension_settings[extensionName].mediaType;
    const regexStr = mediaType === 'image' 
        ? extension_settings[extensionName].imageRegex 
        : extension_settings[extensionName].videoRegex;

    if (!regexStr) {
        debugLog('ERROR', '正则表达式为空');
        return [];
    }

    // 3. 执行正则匹配
    let matches = [];
    try {
        const mediaTagRegex = regexFromString(regexStr);
        if (mediaTagRegex.global) {
            matches = [...textContent.matchAll(mediaTagRegex)];
        } else {
            const singleMatch = textContent.match(mediaTagRegex);
            matches = singleMatch ? [singleMatch] : [];
        }
    } catch (e) {
        debugLog('ERROR', '正则解析错误', e);
        return [];
    }

    // 4. 调试日志：如果文本很长，只打印前50个字
    if (matches.length > 0) {
        debugLog('SCAN', `匹配成功! 找到 ${matches.length} 个标签`, matches.map(m => m[0]));
        debugStats.scanMatches++;
    } else {
        // 如果没匹配到，偶尔打印一下正在扫描的内容，方便排查是否是格式不对
        // 为了防止刷屏，每扫描50次打印一次，或者文本中包含 "<img" 但没匹配上时打印
        if (textContent.includes('<img') || textContent.includes('<video')) {
            debugLog('WARN', `发现潜在标签但正则未匹配。当前文本片段: "${textContent.substring(Math.max(0, textContent.indexOf('<') - 10), textContent.indexOf('<') + 50)}..."`);
            debugLog('WARN', `当前使用的正则: ${regexStr}`);
        }
    }

    if (matches.length === 0) return [];

    // 5. 处理匹配项
    for (const match of matches) {
        const originalTag = match[0];
        const uniqueKey = originalTag.trim();

        if (generatedCache.has(uniqueKey)) continue; // 已生成
        if (processingTags.has(uniqueKey)) continue; // 正在生成

        if (triggerGeneration) {
            triggerBackgroundGeneration(match, mediaType, uniqueKey);
        }
    }

    return matches;
}

/**
 * 后台生成逻辑
 */
async function triggerBackgroundGeneration(match, mediaType, uniqueKey) {
    processingTags.add(uniqueKey);
    debugStats.apiCalls++;
    debugLog('API', `>>> 触发后台生成: ${uniqueKey}`);

    let finalPrompt = '';
    // ... 参数解析代码 ...
    try {
        let originalPrompt = '';
        let originalVideoParams = '';
        let originalLightIntensity = '';

        if (mediaType === 'video') {
            originalVideoParams = typeof match?.[1] === 'string' ? match[1] : '';
            originalPrompt = typeof match?.[2] === 'string' ? match[2] : '';
            // 简单的视频参数处理
            finalPrompt = originalPrompt; 
            if (originalVideoParams) {
                const params = originalVideoParams.split(',');
                if (params.length === 3) {
                     finalPrompt = `{{setvar::videoFrameCount::${params[0]}}}{{setvar::videoWidth::${params[1]}}}{{setvar::videoHeight::${params[2]}}}${originalPrompt}`;
                }
            }
        } else {
            originalLightIntensity = typeof match?.[1] === 'string' ? match[1] : '';
            originalPrompt = typeof match?.[2] === 'string' ? match[2] : '';
            // 简单的图片参数处理
            finalPrompt = originalPrompt;
            if (originalLightIntensity) {
                const arr = originalLightIntensity.split(',');
                if (arr.length === 2) {
                    finalPrompt = `{{setvar::light_intensity::${arr[0]}}}{{setvar::sunshine_intensity::${arr[1]}}}${originalPrompt}`;
                }
            }
        }

        if (!finalPrompt.trim()) {
            debugLog('WARN', 'Prompt为空，跳过生成');
            processingTags.delete(uniqueKey);
            return;
        }

        debugLog('API', `SD Prompt: ${finalPrompt}`);

        // 调用 SD
        const result = await SlashCommandParser.commands['sd'].callback(
            { quiet: 'true' },
            finalPrompt
        );

        debugLog('API', `SD 返回结果: ${result ? '成功' : '空'}`);

        if (typeof result === 'string' && result.trim().length > 0) {
            const style = extension_settings[extensionName].style || '';
            const escapedUrl = escapeHtmlAttribute(result);
            const escapedOriginalPrompt = escapeHtmlAttribute(originalPrompt);
            
            let mediaTag;
            if (mediaType === 'video') {
                mediaTag = `<video src="${escapedUrl}" prompt="${escapedOriginalPrompt}" style="${style}" loop controls autoplay muted/>`;
            } else {
                mediaTag = `<img src="${escapedUrl}" prompt="${escapedOriginalPrompt}" style="${style}" onclick="window.open(this.src)" />`;
            }

            generatedCache.set(uniqueKey, mediaTag);
            debugLog('CACHE', `写入缓存: ${uniqueKey} -> HTML`);
            
            // 主动触发一次DOM更新
            applyCacheToDom();
        } else {
            debugLog('ERROR', 'SD生成返回空字符串');
        }

    } catch (error) {
        debugLog('ERROR', `生成过程异常`, error);
    } finally {
        processingTags.delete(uniqueKey);
    }
}

// --- DOM 观察与处理 ---

/**
 * 核心：获取当前消息文本，执行扫描，执行替换
 */
function applyCacheToDom() {
    // 1. 获取最后一条消息
    // ST 的结构通常是 #chat -> .mes -> .mes_text
    const chatContainer = document.getElementById('chat');
    if (!chatContainer) return;

    const lastMessageBlock = chatContainer.querySelector('.mes:last-child');
    if (!lastMessageBlock) return;

    const lastMessageTextDiv = lastMessageBlock.querySelector('.mes_text');
    if (!lastMessageTextDiv) return;

    // 2. 扫描文本 (触发生成)
    // 重要：使用 textContent 来匹配正则，因为 innerHTML 可能包含转义字符
    const rawText = lastMessageTextDiv.textContent;
    scanAndProcessTags(rawText, true);

    // 3. 替换 DOM (防闪烁)
    let htmlContent = lastMessageTextDiv.innerHTML;
    let hasChanges = false;

    generatedCache.forEach((mediaHtml, originalTag) => {
        // 检查 HTML 中是否还包含原始标签
        if (htmlContent.includes(originalTag)) {
            htmlContent = htmlContent.replace(originalTag, mediaHtml);
            hasChanges = true;
            debugStats.cacheHits++;
        }
    });

    if (hasChanges) {
        lastMessageTextDiv.innerHTML = htmlContent;
        debugStats.domReplacements++;
        // debugLog('DOM', '已替换 DOM 内容');
    }
}

function startObserver() {
    if (observer) observer.disconnect();
    const chatContainer = document.getElementById('chat');
    if (!chatContainer) {
        debugLog('ERROR', '未找到 #chat 容器，无法启动观察者');
        return;
    }

    debugLog('INFO', 'Observer 启动');
    
    observer = new MutationObserver((mutations) => {
        debugStats.eventsTriggered++;
        // 每次 DOM 变动都尝试处理
        applyCacheToDom();
    });

    observer.observe(chatContainer, {
        childList: true,
        subtree: true,
        characterData: true
    });
}

function stopObserver() {
    if (observer) {
        observer.disconnect();
        observer = null;
        debugLog('INFO', 'Observer 停止');
    }
}

async function finalizeMessageContent() {
    debugLog('INFO', '正在执行 Finalize (最终保存)');
    const context = getContext();
    if (!context.chat || context.chat.length === 0) return;
    
    const messageIndex = context.chat.length - 1;
    const message = context.chat[messageIndex];
    if (!message || !message.mes) return;

    let content = message.mes;
    let isModified = false;

    generatedCache.forEach((mediaHtml, originalTag) => {
        if (content.includes(originalTag)) {
            content = content.replace(originalTag, mediaHtml);
            isModified = true;
            debugStats.finalReplacements++;
        }
    });

    if (isModified) {
        message.mes = content;
        updateMessageBlock(messageIndex, message);
        await context.saveChat();
        debugLog('INFO', 'Finalize 完成，数据已保存');
    }
    debugLog('STATS');
}

// --- 事件监听 ---

eventSource.on(event_types.GENERATION_STARTED, () => {
    debugLog('EVENT', 'GENERATION_STARTED');
    resetStats();
    
    // 如果启用了流式，启动观察者
    if (extension_settings[extensionName]?.streamGeneration) {
        const context = getContext();
        const newIndex = context.chat.length;
        if (newIndex !== currentProcessingIndex) {
            processingTags.clear();
            generatedCache.clear();
            currentProcessingIndex = newIndex;
            debugLog('INFO', '新消息，缓存清空');
        }
        isStreamActive = true;
        startObserver();
    }
});

const onGenerationFinished = async () => {
    debugLog('EVENT', 'FINISHED');
    if (isStreamActive) {
        isStreamActive = false;
        stopObserver();
        setTimeout(finalizeMessageContent, 300);
    }
};

eventSource.on(event_types.GENERATION_ENDED, onGenerationFinished);
eventSource.on(event_types.GENERATION_STOPPED, onGenerationFinished);

// --- 初始化 ---
$(function () {
    (async function () {
        // 加载设置 HTML
        const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
        $('#extensionsMenu').append(`<div id="auto_generation" class="list-group-item flex-container flexGap5"><div class="fa-solid fa-film"></div><span data-i18n="Media Auto Generation">Media Auto Generation</span></div>`);
        $('#auto_generation').on('click', () => {
             const extensionsDrawer = $('#extensions-settings-button .drawer-toggle');
             if ($('#rm_extensions_block').hasClass('closedDrawer')) extensionsDrawer.trigger('click');
             setTimeout(() => {
                 const container = $('#media_auto_generation_container');
                 if (container.length) {
                     $('#rm_extensions_block').animate({ scrollTop: container.offset().top - $('#rm_extensions_block').offset().top + $('#rm_extensions_block').scrollTop() }, 500);
                     container.find('.inline-drawer-header').trigger('click');
                 }
             }, 500);
        });

        // 确保先加载设置再处理
        await loadSettings();

        if (!$('#media_auto_generation_container').length) {
            $('#extensions_settings2').append('<div id="media_auto_generation_container" class="extension_container"></div>');
        }
        $('#media_auto_generation_container').empty().append(settingsHtml);
        
        // 绑定事件
        $('#mediaType').on('change', function() { extension_settings[extensionName].mediaType = $(this).val(); saveSettingsDebounced(); updateUI(); });
        $('#stream_generation').on('change', function() { extension_settings[extensionName].streamGeneration = $(this).prop('checked'); saveSettingsDebounced(); });
        // ... 其他绑定省略 ...

        updateUI();
        console.log(`${LOG_PREFIX} 插件加载完成`);
    })();
});
