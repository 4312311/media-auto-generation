// 媒体自动生成插件主脚本 - 最终完善版
// 修复并发显示 + 优化进度提示逻辑（移除误导性的总数显示）

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
let updateDebounceTimer = null; 

// 1. 生成结果缓存 (Key: Hash -> Value: HTML Tag)
const generatedCache = new Map();

// 2. 历史记录 (冷却锁)
const promptHistory = new Map();

// 3. 并发处理锁 (生成锁)
const processingHashes = new Set();

// 冷却时间设置：3分钟
const PROMPT_COOLDOWN_MS = 180000;

// 默认设置 (新增 characterTags)
const defaultSettings = {
    mediaType: 'disabled',
    imageRegex: '/<pic\b(?![^>]*\bsrc\s*=)(?:(?:(?!\bprompt\b)[^>])*\blight_intensity\s*=\s*"([^"]*)")?(?:(?!\bprompt\b)[^>])*\bprompt\s*=\s*"([^"]*)"[^>]*>/gi',
    videoRegex: '/<video\b(?:(?:(?!\bprompt\b)[^>])*\bvideoParams\s*=\s*"([^"]*)")?(?:(?!\bprompt\b)[^>])*\bprompt\s*=\s*"([^"]*)"[^>]*>/gi',
    style: 'width:100%;height:auto',
    streamGeneration: false,
    characterTags: {}, // --- 新增: 角色固定特征字典 ---
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

// --- 新增: 核心注入工具函数 ---

// 正则转义工具，防止角色名中包含特殊符号导致正则报错
function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 角色特征自动注入逻辑
 * @param {string} rawPrompt 原始提示词
 * @param {object} tagsDict 角色特征字典
 * @returns {object} { modifiedPrompt: string, injected: boolean }
 */
function injectCharacterTags(rawPrompt, tagsDict) {
    if (!tagsDict || Object.keys(tagsDict).length === 0) return { modifiedPrompt: rawPrompt, injected: false };
    
    let modifiedPrompt = rawPrompt;
    let injected = false;
    
    for (const [charName, tags] of Object.entries(tagsDict)) {
        if (!charName.trim() || !tags.trim()) continue;
        
        // 使用单词边界 \b 进行精确匹配，忽略大小写 (gi)
        const regex = new RegExp(`\\b${escapeRegExp(charName)}\\b`, 'gi');
        
        if (regex.test(modifiedPrompt)) {
            // 将匹配到的名字替换为 "名字, 特征tag" 格式
            modifiedPrompt = modifiedPrompt.replace(regex, (match) => {
                return `${match}, ${tags}`;
            });
            injected = true;
        }
    }
    return { modifiedPrompt, injected };
}

// --- 设置与UI逻辑 ---

// --- 新增: 渲染角色列表UI ---
function renderCharacterTagsList() {
    const container = $('#character_tags_list');
    if (!container.length) return;
    
    container.empty();
    const tagsDict = extension_settings[extensionName].characterTags || {};
    const keys = Object.keys(tagsDict);
    
    if (keys.length === 0) {
        container.append('<div style="text-align: center; opacity: 0.5; font-size: 0.9em; padding: 10px;" id="empty_tags_tip" data-i18n="No characters added yet.">No characters added yet.</div>');
        return;
    }

    for (const charName of keys) {
        const tags = tagsDict[charName];
        const escapedName = escapeHtmlAttribute(charName);
        const escapedTags = escapeHtmlAttribute(tags);
        
        const rowHtml = `
            <div class="flex-container align_center flexGap5 char-tag-row" style="padding: 3px; border-bottom: 1px dashed var(--SmartThemeBorderColor);">
                <span style="flex: 1; font-weight: bold; overflow: hidden; text-overflow: ellipsis;" title="${escapedName}">${escapedName}</span>
                <span style="flex: 2; font-size: 0.9em; opacity: 0.8; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escapedTags}">${escapedTags}</span>
                <div class="menu_button menu_button_icon delete-char-tag-btn" data-name="${escapedName}" title="Delete" style="margin: 0; padding: 5px;">
                    <i class="fa-solid fa-trash interactable"></i>
                </div>
            </div>
        `;
        container.append(rowHtml);
    }

    // 绑定删除按钮事件
    container.find('.delete-char-tag-btn').off('click').on('click', function() {
        const nameToDelete = $(this).attr('data-name');
        if (nameToDelete && extension_settings[extensionName].characterTags[nameToDelete]) {
            delete extension_settings[extensionName].characterTags[nameToDelete];
            saveSettingsDebounced();
            renderCharacterTagsList(); // 重新渲染列表
        }
    });
}

function updateUI() {
    if ($('#mediaType').length) {
        $('#mediaType').val(extension_settings[extensionName].mediaType);
        $('#image_regex').val(extension_settings[extensionName].imageRegex);
        $('#video_regex').val(extension_settings[extensionName].videoRegex);
        $('#media_style').val(extension_settings[extensionName].style);
        $('#stream_generation').prop('checked', extension_settings[extensionName].streamGeneration ?? false);
        
        // --- 新增: 更新UI时一并渲染角色列表 ---
        renderCharacterTagsList();
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

    // --- 新增: 绑定添加角色按钮事件 ---
    $('#add_char_tag_btn').off('click').on('click', function() {
        const nameInput = $('#new_char_name').val().trim();
        const tagsInput = $('#new_char_tags').val().trim();
        
        if (!nameInput || !tagsInput) {
            toastr.warning('角色名称和特征Tags不能为空 / Name and Tags cannot be empty.');
            return;
        }

        extension_settings[extensionName].characterTags = extension_settings[extensionName].characterTags || {};
        extension_settings[extensionName].characterTags[nameInput] = tagsInput;
        
        saveSettingsDebounced();
        
        // 清空输入框并刷新列表
        $('#new_char_name').val('');
        $('#new_char_tags').val('');
        renderCharacterTagsList();
    });

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
 */
function requestDebouncedUpdate(isFinal = false) {
    if (updateDebounceTimer) clearTimeout(updateDebounceTimer);
    updateDebounceTimer = setTimeout(() => {
        processMessageContent(isFinal, false); // 执行真正的替换
    }, 200); // 200ms 缓冲
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

    // 使用 entries() 获取当前是第几个匹配项 (index)
    for (const [index, match] of matches.entries()) {
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

        // --- 新增: 角色固定特征拦截与注入 ---
        const injectionResult = injectCharacterTags(rawPrompt, extension_settings[extensionName].characterTags);
        const modifiedPrompt = injectionResult.modifiedPrompt;
        
        // 打印日志：仅在成功注入且非流式频繁检测时打印，避免刷屏
        if (injectionResult.injected && !onlyTrigger) {
            console.log(`[${extensionName}] 🎯 角色特征匹配成功，已自动注入！`);
            console.log(`[${extensionName}] Original Prompt:`, rawPrompt);
            console.log(`[${extensionName}] Modified Prompt:`, modifiedPrompt);
        }

        // 注意：使用注入后的 modifiedPrompt 计算 Hash，确保特征修改后能重新生成
        const promptHash = simpleHash(normalizePrompt(modifiedPrompt));

        // --- 逻辑 A：替换已完成的图片 ---
        if (!onlyTrigger && generatedCache.has(promptHash)) {
            const cachedMediaTag = generatedCache.get(promptHash);
            
            // 执行文本替换
            currentMessageText = currentMessageText.replace(originalTag, cachedMediaTag);
            contentModified = true;
            
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
            let toast = null;

            try {
                // 注意：这里发送给后台的是注入了固定Tag的 modifiedPrompt
                let finalPrompt = modifiedPrompt; 
                
                if (mediaType === 'video') {
                    if (rawExtraParams && rawExtraParams.trim()) {
                        const params = rawExtraParams.split(',');
                        if (params.length === 3) {
                            const [frameCount, width, height] = params;
                            finalPrompt = `{{setvar::videoFrameCount::${frameCount}}}{{setvar::videoWidth::${width}}}{{setvar::videoHeight::${height}}}` + finalPrompt;
                        }
                    }
                } else {
                    if (rawExtraParams && rawExtraParams.trim()) {
                        const intensityArr = rawExtraParams.split(',').map(item => item.trim());
                        if (intensityArr.length === 2) {
                            const lightIntensity = Math.round(parseFloat(intensityArr[0]) * 100) / 100 || 0;
                            const sunshineIntensity = Math.round(parseFloat(intensityArr[1]) * 100) / 100 || 0;
                            finalPrompt = `{{setvar::light_intensity::${lightIntensity}}}{{setvar::sunshine_intensity::${sunshineIntensity}}}` + finalPrompt;
                        }
                    }
                }

                const mediaTypeText = mediaType === 'image' ? '图片' : '视频';
                const toastrOptions = { timeOut: 0, extendedTimeOut: 0, closeButton: true };
                
                // 【修改点】：只显示当前是第几张 (基于文本顺序)，不显示未知总数
                const baseText = `⏳ 生成第 ${index + 1} 张${mediaTypeText}...`;
                toast = toastr.info(`${baseText} ${seconds}s`, '', toastrOptions);

                timer = setInterval(() => {
                    seconds++;
                    if (toast && toast.find) {
                        toast.find('.toast-message').text(`${baseText} ${seconds}s`);
                    }
                }, 1000);

                // 调用 SD 接口
                const result = await SlashCommandParser.commands['sd'].callback({ quiet: 'true' }, finalPrompt);

                clearInterval(timer);
                if (toast) toastr.clear(toast);

                if (typeof result === 'string' && result.trim().length > 0) {
                    const style = extension_settings[extensionName].style || '';
                    const escapedUrl = escapeHtmlAttribute(result);
                    // HTML标签上依然保留原始的 rawPrompt 避免文本污染，后台生成使用 modifiedPrompt
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

                    // 成功后立即解锁
                    processingHashes.delete(promptHash);

                    // 兜底更新：非流式 或 队列清空时强制更新
                    if (!isStreamActive || processingHashes.size === 0) {
                        requestDebouncedUpdate(true); 
                    }
                } else {
                     throw new Error("Empty result from SD");
                }

            } catch (error) {
                console.error(`[${extensionName}] Generation failed:`, error);
                if (timer) clearInterval(timer);
                if (toast) toastr.clear(toast);
                toastr.error(`Media generation error: ${error}`);
                
                // 出错清理
                promptHistory.delete(promptHash);
                processingHashes.delete(promptHash);
            } finally {
                // 兜底清理
                if (processingHashes.has(promptHash)) {
                    processingHashes.delete(promptHash);
                }
            }
        })();
    }

    // --- 提交更新 ---
    if (!onlyTrigger && contentModified) {
        message.mes = currentMessageText;
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
    
    // 流式期间只触发生成，不修改界面
    streamInterval = setInterval(() => {
        if (!isStreamActive) { clearInterval(streamInterval); return; }
        processMessageContent(false, true); 
    }, 500);
});

// 流式传输结束的回调
const onGenerationFinished = async () => {
    if (streamInterval) { clearInterval(streamInterval); streamInterval = null; }
    isStreamActive = false;
    
    pruneOldPrompts();
    // 流式结束，申请一次最终更新
    requestDebouncedUpdate(true);
};

eventSource.on(event_types.GENERATION_ENDED, onGenerationFinished);
eventSource.on(event_types.GENERATION_STOPPED, onGenerationFinished);

// 非流式/加载时
eventSource.on(event_types.MESSAGE_RECEIVED, async () => {
    pruneOldPrompts();
    await processMessageContent(true, false);
});
