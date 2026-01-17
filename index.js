// 媒体自动生成插件主脚本 - 最终完善版 (v3.0)
// 修复：变量竞争(SetVar)、并发控制、流式/非流式逻辑隔离、智能兜底

import { extension_settings, getContext } from '../../../extensions.js';
import {
    saveSettingsDebounced,
    eventSource,
    event_types,
    updateMessageBlock,
    substituteParams // 必需：用于执行 setvar 宏
} from '../../../../script.js';
import { regexFromString } from '../../../utils.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';

const extensionName = 'media-auto-generation';
const extensionFolderPath = `/scripts/extensions/third-party/${extensionName}`;

// --- 全局状态管理 ---

let isStreamActive = false;
let streamInterval = null;
let updateDebounceTimer = null;

// 1. 生成结果缓存 (Key: Hash -> Value: HTML Tag)
const generatedCache = new Map();

// 2. 历史记录 (冷却锁, Key: Hash -> Value: Timestamp)
const promptHistory = new Map();

// 3. 并发处理锁 (生成锁, Key: Hash)
const processingHashes = new Set();

// 冷却时间设置：3分钟
const PROMPT_COOLDOWN_MS = 180000;

// 默认设置
const defaultSettings = {
    mediaType: 'disabled',
    // 用户指定的正则
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

/**
 * 通用解析器：从 Match 中提取 Prompt 和 宏字符串
 */
function extractPromptInfo(match, mediaType) {
    // 兼容不同的正则捕获组位置
    // 假设正则结构：Group 1 = Params, Group 2 = Prompt (或者反过来，视具体正则而定)
    // 根据用户提供的正则：
    // imageRegex: group 1 = light_intensity, group 2 = prompt
    // videoRegex: group 1 = videoParams, group 2 = prompt
    
    let rawExtraParams = match[1] || "";
    let rawPrompt = (match[2] || "").trim();

    // 兜底逻辑：如果正则顺序反了
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
        // 图片模式 (light_intensity)
        if (rawExtraParams) {
            const intensityArr = rawExtraParams.split(',').map(s => s.trim());
            const lightIntensity = intensityArr[0] ? intensityArr[0] : 0;
            const sunshineIntensity = intensityArr[1] ? intensityArr[1] : 0;
            macroString = `{{setvar::light_intensity::${lightIntensity}}}{{setvar::sunshine_intensity::${sunshineIntensity}}}`;
        }
    }

    return { rawPrompt, rawExtraParams, macroString };
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

// --- 核心业务逻辑 ---

/**
 * 构造 HTML 标签
 */
function buildMediaTag(resultUrl, rawPrompt, rawParams, mediaType) {
    const style = extension_settings[extensionName].style || '';
    const escapedUrl = escapeHtmlAttribute(resultUrl);
    const escapedOriginalPrompt = escapeHtmlAttribute(rawPrompt);
    const escapedParams = escapeHtmlAttribute(rawParams);

    if (mediaType === 'video') {
        return `<video src="${escapedUrl}" ${escapedParams ? `videoParams="${escapedParams}"` : ''} prompt="${escapedOriginalPrompt}" style="${style}" loop controls autoplay muted/>`;
    } else {
        // 保留原有的 light_intensity 属性作为元数据
        const lightAttr = escapedParams ? `light_intensity="${escapedParams}"` : 'light_intensity="0"';
        return `<img src="${escapedUrl}" ${lightAttr} prompt="${escapedOriginalPrompt}" style="${style}" onclick="window.open(this.src)" />`;
    }
}

/**
 * 刷新消息界面 (防抖)
 */
function requestDebouncedUpdate(messageIndex, newMessage) {
    if (updateDebounceTimer) clearTimeout(updateDebounceTimer);
    updateDebounceTimer = setTimeout(async () => {
        updateMessageBlock(messageIndex, newMessage);
        await eventSource.emit(event_types.MESSAGE_UPDATED, messageIndex);
    }, 200);
}

/**
 * 管道 1：流式处理 (并发，不阻塞，仅触发生成)
 * 适用于：用户勾选了 "Stream Generation" 且正在流式传输时
 */
async function processStreamPipeline() {
    if (!extension_settings[extensionName] || extension_settings[extensionName].mediaType === 'disabled') return;
    
    const context = getContext();
    const message = context.chat[context.chat.length - 1];
    if (!message || message.is_user || !message.mes) return;

    const mediaType = extension_settings[extensionName].mediaType;
    const regexStr = mediaType === 'image' ? extension_settings[extensionName].imageRegex : extension_settings[extensionName].videoRegex;
    const mediaTagRegex = regexFromString(regexStr);
    const matches = [...message.mes.matchAll(mediaTagRegex)];

    for (const [index, match] of matches.entries()) {
        const originalTag = match[0];
        if (originalTag.includes('src=') || originalTag.includes('src =')) continue; // 已处理

        const info = extractPromptInfo(match, mediaType);
        if (!info) continue;

        const promptHash = simpleHash(normalizePrompt(info.rawPrompt));

        // 如果已经在处理或已缓存，跳过
        if (processingHashes.has(promptHash) || generatedCache.has(promptHash)) continue;
        
        // 检查冷却
        const now = Date.now();
        if (promptHistory.has(promptHash)) {
             if (now - promptHistory.get(promptHash) < PROMPT_COOLDOWN_MS) continue;
        }

        // 锁定
        processingHashes.add(promptHash);
        promptHistory.set(promptHash, now);

        // 异步执行 (Fire-and-Forget)
        (async () => {
            try {
                // 1. 关键：应用宏，设置变量 (虽然是异步，但 Await 保证了在发起 SD 请求前变量已设置)
                // 在流式中，由于 Token 是逐个输出，两个标签之间有时间差，通常不会冲突
                if (info.macroString) {
                    await substituteParams(info.macroString);
                }

                // 2. 解析 Prompt
                const finalPrompt = await substituteParams(info.rawPrompt);

                // UI Toast
                const mediaTypeText = mediaType === 'image' ? '图片' : '视频';
                toastr.info(`流式触发: 正在生成第 ${index + 1} 张${mediaTypeText}...`, '', { timeOut: 3000 });

                // 3. 调用 SD (不等待结果，让后台跑)
                const result = await SlashCommandParser.commands['sd'].callback({ quiet: 'true' }, finalPrompt);
                
                if (result && result.trim().length > 0) {
                    const tag = buildMediaTag(result, info.rawPrompt, info.rawExtraParams, mediaType);
                    generatedCache.set(promptHash, tag);
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
 * 管道 2：非流式/最终处理 (严格串行，阻塞，替换文本)
 * 适用于：消息传输结束 (MESSAGE_RECEIVED) 或 兜底处理
 */
async function processSerialPipeline() {
    if (!extension_settings[extensionName] || extension_settings[extensionName].mediaType === 'disabled') return;

    const context = getContext();
    const messageIndex = context.chat.length - 1;
    const message = context.chat[messageIndex];
    if (!message || message.is_user || !message.mes) return;

    const mediaType = extension_settings[extensionName].mediaType;
    const regexStr = mediaType === 'image' ? extension_settings[extensionName].imageRegex : extension_settings[extensionName].videoRegex;
    const mediaTagRegex = regexFromString(regexStr);
    
    // 获取所有匹配
    const matches = [...message.mes.matchAll(mediaTagRegex)];
    if (matches.length === 0) return;

    let contentModified = false;
    let currentMessageText = message.mes;
    let fallbackWarningTriggered = false;

    // --- 步骤 A: 优先替换缓存 (极速) ---
    for (const match of matches) {
        const originalTag = match[0];
        if (originalTag.includes('src=') || originalTag.includes('src =')) continue;

        const info = extractPromptInfo(match, mediaType);
        if (!info) continue;

        const promptHash = simpleHash(normalizePrompt(info.rawPrompt));

        if (generatedCache.has(promptHash)) {
            currentMessageText = currentMessageText.replace(originalTag, generatedCache.get(promptHash));
            contentModified = true;
        }
    }

    // --- 步骤 B: 处理未生成的 (严格串行 Loop) ---
    // 这是为了解决非流式下，并发 setvar 导致 LoRA 覆盖的问题
    for (const [index, match] of matches.entries()) {
        const originalTag = match[0];
        // 如果上面缓存替换过了，现在的文本里应该没有这个 tag 了？不对，replace 返回新串。
        // 检查当前文本是否还需要替换
        if (!currentMessageText.includes(originalTag)) continue; 
        if (originalTag.includes('src=') || originalTag.includes('src =')) continue;

        const info = extractPromptInfo(match, mediaType);
        if (!info) continue;

        const promptHash = simpleHash(normalizePrompt(info.rawPrompt));

        // 再次检查缓存 (防止重复)
        if (generatedCache.has(promptHash)) {
            currentMessageText = currentMessageText.replace(originalTag, generatedCache.get(promptHash));
            contentModified = true;
            continue;
        }

        // 检查锁和冷却
        if (processingHashes.has(promptHash)) {
            // 如果正在流式生成中，我们可以选择等待，或者暂时跳过等下次刷新
            // 这里选择跳过，相信流式管道会完成它
            continue; 
        }

        const now = Date.now();
        if (promptHistory.has(promptHash)) {
             if (now - promptHistory.get(promptHash) < PROMPT_COOLDOWN_MS) continue;
        }

        // --- 触发智能兜底警告 ---
        // 如果用户开启了流式，但代码运行到了串行生成这一步，说明流式没抓到（可能是文本太快，或者环境不支持）
        if (extension_settings[extensionName].streamGeneration && !fallbackWarningTriggered) {
            toastr.warning('检测到流式传输未生效（或消息瞬间加载），已自动切换为串行生成模式以保证正确性。若此提示频繁出现，请检查网络或关闭插件的“流式生成”选项。', '模式自动切换', { timeOut: 8000 });
            fallbackWarningTriggered = true;
        }

        // 锁定
        processingHashes.add(promptHash);
        promptHistory.set(promptHash, now);

        let timer;
        let seconds = 0;
        let toast = null;

        try {
            // 1. 【串行关键】等待 substituteParams 执行完毕
            if (info.macroString) {
                await substituteParams(info.macroString);
            }

            // 2. 解析 Prompt
            const finalPrompt = await substituteParams(info.rawPrompt);

            // UI 提示
            const mediaTypeText = mediaType === 'image' ? '图片' : '视频';
            const baseText = `⏳ [串行] 生成第 ${index + 1} 张${mediaTypeText}...`;
            
            toast = toastr.info(`${baseText} ${seconds}s`, '', { timeOut: 0, extendedTimeOut: 0 });
            timer = setInterval(() => {
                seconds++;
                if (toast && toast.find) toast.find('.toast-message').text(`${baseText} ${seconds}s`);
            }, 1000);

            // 3. 【串行关键】Await 等待 SD 返回。只有这张图生成完，才会进入下一次循环设置下一个变量。
            const result = await SlashCommandParser.commands['sd'].callback({ quiet: 'true' }, finalPrompt);

            clearInterval(timer);
            if (toast) toastr.clear(toast);

            if (result && result.trim().length > 0) {
                const tag = buildMediaTag(result, info.rawPrompt, info.rawExtraParams, mediaType);
                
                // 写入缓存
                generatedCache.set(promptHash, tag);
                
                // 立即替换文本
                currentMessageText = currentMessageText.replace(originalTag, tag);
                contentModified = true;

                // 每生成一张，刷新一次界面，提升体验
                message.mes = currentMessageText;
                requestDebouncedUpdate(messageIndex, message);
            }

        } catch (err) {
            console.error('Serial generation failed:', err);
            if (timer) clearInterval(timer);
            if (toast) toastr.clear(toast);
            promptHistory.delete(promptHash); // 失败回滚，允许重试
        } finally {
            processingHashes.delete(promptHash);
        }
    } // End Loop

    // 最终保存
    if (contentModified) {
        message.mes = currentMessageText;
        updateMessageBlock(messageIndex, message);
        await eventSource.emit(event_types.MESSAGE_UPDATED, messageIndex);
        const finalContext = getContext();
        await finalContext.saveChat();
        toastr.success('所有媒体内容生成完毕');
    }
}

// --- 事件监听 ---

eventSource.on(event_types.GENERATION_STARTED, () => {
    // 每次开始生成时，清空运行时锁
    processingHashes.clear();
    
    // 如果未开启流式，什么都不做，坐等 MESSAGE_RECEIVED
    if (!extension_settings[extensionName]?.streamGeneration) return;

    isStreamActive = true;
    if (streamInterval) clearInterval(streamInterval);
    
    // 启动流式扫描 (只触发，不替换)
    streamInterval = setInterval(() => {
        if (!isStreamActive) { clearInterval(streamInterval); return; }
        processStreamPipeline(); 
    }, 500);
});

const onGenerationFinished = async () => {
    if (streamInterval) { clearInterval(streamInterval); streamInterval = null; }
    isStreamActive = false;
    
    // 清理过期历史
    pruneOldPrompts();
};

eventSource.on(event_types.GENERATION_ENDED, onGenerationFinished);
eventSource.on(event_types.GENERATION_STOPPED, onGenerationFinished);

// 非流式/最终/加载时/兜底
eventSource.on(event_types.MESSAGE_RECEIVED, async () => {
    onGenerationFinished(); // 确保流式定时器已关闭
    // 启动串行管道处理剩余或全部图片
    await processSerialPipeline();
});
