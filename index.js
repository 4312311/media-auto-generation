// 媒体自动生成插件主脚本 - 修复版
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

// --- 全局状态管理 ---
let isStreamActive = false;
let streamInterval = null;
const processingTags = new Set();
const generatedCache = new Map(); 
let currentProcessingIndex = -1;
const currentSessionPrompts = new Set();
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
 * @param {boolean} isFinal - 是否是最终检查
 * @param {boolean} onlyFromCache - 【关键参数】如果为 true，只执行缓存替换，绝对不发起新生成
 */
async function processMessageContent(isFinal = false, onlyFromCache = false) {
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
        
        // 绝对防御：如果已有 src=，跳过
        if (originalTag.includes('src=') || originalTag.includes('src =')) continue;
        
        const uniqueKey = originalTag.trim();

        // 1. 缓存回填 (最优先)
        if (generatedCache.has(uniqueKey)) {
            const cachedMediaTag = generatedCache.get(uniqueKey);
            if (message.mes.includes(uniqueKey)) {
                console.log(`[${extensionName}] [DEBUG] 缓存命中，恢复图片: ${uniqueKey.substring(0, 15)}...`);
                message.mes = message.mes.replace(uniqueKey, cachedMediaTag);
                updateMessageBlock(messageIndex, message);
                if (isFinal) await context.saveChat();
            }
            continue;
        }

        // 2. 如果开启了【仅缓存模式】，在此处拦截，不进行后续生成
        // 这是解决 message_received 重复生成的关键
        if (onlyFromCache) {
            console.log(`[${extensionName}] [DEBUG] 仅缓存模式跳过新生成: ${uniqueKey.substring(0, 15)}...`);
            continue;
        }

        // 3. 并发保护
        if (processingTags.has(uniqueKey)) continue;

        // 4. Prompt 幂等性检查
        let extractedPrompt = (match[2] || "").trim();
        if (!extractedPrompt && match[1] && !match[0].includes('light_intensity') && !match[0].includes('videoParams')) {
             extractedPrompt = match[1].trim();
        }
        
        if (extractedPrompt) {
            if (currentSessionPrompts.has(extractedPrompt)) {
                console.log(`[${extensionName}] [拦截] 重复 Prompt: ${extractedPrompt.substring(0, 10)}...`);
                continue;
            }
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
        // GENERATION_ENDED 触发的检查：isFinal=true, onlyFromCache=false (允许补漏生成)
        processMessageContent(true, false);
        
        // 报警逻辑
        const pluginStreamSetting = extension_settings[extensionName]?.streamGeneration;
        if (pluginStreamSetting && !realStreamingDetected) {
            const context = getContext();
            if (context.chat && context.chat.length > 0) {
                 alert("【Media Auto Gen 警告】\n检测到您开启了插件的「流式生成」，但SillyTavern实际未进行流式传输。\n请在SillyTavern设置中开启Stream，或关闭本插件的流式选项。");
            }
        } else if (!pluginStreamSetting && realStreamingDetected) {
            alert("【Media Auto Gen 警告】\n检测到SillyTavern正在流式传输，但本插件「流式生成」未开启。\n建议开启插件的 Stream Generation 以获得最佳体验。");
        }
    }, 300);
};

eventSource.on(event_types.GENERATION_STARTED, () => {
    realStreamingDetected = false;
    currentSessionPrompts.clear(); // 新生成开始，清空 Prompt 历史

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
        // 流式过程中：isFinal=false, onlyFromCache=false (允许生成)
        processMessageContent(false, false);
    }, 2000);
});

eventSource.on(event_types.STREAM_TOKEN_RECEIVED, () => {
    realStreamingDetected = true;
});

// 生成结束：通过防抖触发 Active Check
const onGenerationFinished = async () => {
    if (streamInterval) { clearInterval(streamInterval); streamInterval = null; }
    isStreamActive = false;
    triggerFinalCheck();
};

eventSource.on(event_types.GENERATION_ENDED, onGenerationFinished);
eventSource.on(event_types.GENERATION_STOPPED, onGenerationFinished);

// 消息接收：【关键修改】
eventSource.on(event_types.MESSAGE_RECEIVED, async () => {
    const context = getContext();
    if (!context.chat || context.chat.length === 0) return;
    const newIndex = context.chat.length - 1;
    
    // 如果索引变了，说明是新消息，清理环境
    if (newIndex !== currentProcessingIndex) {
        processingTags.clear();
        generatedCache.clear();
        currentSessionPrompts.clear();
        currentProcessingIndex = newIndex;
    }

    // 判断是否处于流式模式（根据设置）
    const isStreamingMode = extension_settings[extensionName]?.streamGeneration;

    // 如果开启了流式模式，MESSAGE_RECEIVED 强制开启【仅缓存模式】
    // 也就是：processMessageContent(true, true);
    // 这样它只能恢复图片，绝对不会发起生成，解决了你的重复生成问题
    // 如果没开流式模式，则保持默认行为 (false)，允许生成
    await processMessageContent(true, isStreamingMode);
});

// 防抖计时器 (解决事件冲突)
let finalCheckTimer = null;

/**
 * 转义HTML属性值中的特殊字符
 * @param {string} value
 * @returns {string}
 */
function escapeHtmlAttribute(value) {
    if (typeof value !== 'string') {
        return '';
    }

    return value
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// 默认设置
const defaultSettings = {
    mediaType: 'disabled', // 默认禁用
    imageRegex: '/<img\\b(?:(?:(?!\\bprompt\\b)[^>])*\\blight_intensity\\s*=\\s*"([^"]*)")?(?:(?!\\bprompt\\b)[^>])*\\bprompt\\s*=\\s*"([^"]*)"[^>]*>/gi',
    videoRegex: '/<video\b(?:(?:(?!\bprompt\b)[^>])*\bvideoParams\s*=\s*"([^"]*)")?(?:(?!\bprompt\b)[^>])*\bprompt\s*=\s*"([^"]*)"[^>]*>/gi',
    style: 'width:auto;height:auto', // 默认图片样式
    streamGeneration: false, // 默认关闭流式生成
};

// 从设置更新UI
function updateUI() {
    console.log(`[${extensionName}] 正在更新UI`);
    
    // 只在表单元素存在时更新它们
    if ($('#mediaType').length) {
        $('#mediaType').val(extension_settings[extensionName].mediaType);
        $('#image_regex').val(extension_settings[extensionName].imageRegex);
        $('#video_regex').val(extension_settings[extensionName].videoRegex);
        $('#media_style').val(extension_settings[extensionName].style);
        // 更新流式开关状态
        $('#stream_generation').prop('checked', extension_settings[extensionName].streamGeneration ?? false);
    }
}

// 加载设置
async function loadSettings() {
    console.log(`[${extensionName}] 正在加载设置`);
    
    extension_settings[extensionName] = extension_settings[extensionName] || {};

    // 如果设置为空或缺少必要属性，使用默认设置
    if (Object.keys(extension_settings[extensionName]).length === 0) {
        console.log(`[${extensionName}] 未找到现有设置，使用默认设置`);
        Object.assign(extension_settings[extensionName], defaultSettings);
    } else {
        // 确保所有必要属性都存在
        for (const key in defaultSettings) {
            if (extension_settings[extensionName][key] === undefined) {
                console.log(`[${extensionName}] 缺少设置${key}，使用默认值`);
                extension_settings[extensionName][key] = defaultSettings[key];
            }
        }
    }

    updateUI();
}

// 创建设置页面
async function createSettings(settingsHtml) {
    console.log(`[${extensionName}] 正在创建设置页面`);
    
    // 创建一个容器来存放设置
    if (!$('#media_auto_generation_container').length) {
        $('#extensions_settings2').append(
            '<div id="media_auto_generation_container" class="extension_container"></div>',
        );
    }

    // 使用传入的settingsHtml
    $('#media_auto_generation_container').empty().append(settingsHtml);

    // 添加设置变更事件处理
    $('#mediaType').on('change', function () {
        const newValue = $(this).val();
        console.log(`[${extensionName}] 媒体类型已更改为: ${newValue}`);
        extension_settings[extensionName].mediaType = newValue;
        
        // 根据选择设置默认样式
        if (newValue === 'video' && !extension_settings[extensionName].style) {
            extension_settings[extensionName].style = 'width:100%;height:auto';
            $('#media_style').val(extension_settings[extensionName].style);
        } else if (newValue === 'image' && !extension_settings[extensionName].style) {
            extension_settings[extensionName].style = 'width:auto;height:auto';
            $('#media_style').val(extension_settings[extensionName].style);
        }
        
        updateUI();
        saveSettingsDebounced();
    });

    $('#image_regex').on('input', function () {
        console.log(`[${extensionName}] 图片正则表达式已更新`);
        extension_settings[extensionName].imageRegex = $(this).val();
        saveSettingsDebounced();
    });

    $('#video_regex').on('input', function () {
        console.log(`[${extensionName}] 视频正则表达式已更新`);
        extension_settings[extensionName].videoRegex = $(this).val();
        saveSettingsDebounced();
    });

    $('#media_style').on('input', function () {
        console.log(`[${extensionName}] 样式已更新`);
        extension_settings[extensionName].style = $(this).val();
        saveSettingsDebounced();
    });

    // 新增：监听流式开关变更
    $('#stream_generation').on('change', function () {
        const newValue = $(this).prop('checked');
        console.log(`[${extensionName}] 流式生成设置已更新: ${newValue}`);
        extension_settings[extensionName].streamGeneration = newValue;
        saveSettingsDebounced();
    });

    // 初始化设置值
    updateUI();
}

// 设置面板点击处理函数
function onExtensionButtonClick() {
    console.log(`[${extensionName}] 扩展按钮被点击`);
    
    // 直接访问扩展设置面板
    const extensionsDrawer = $('#extensions-settings-button .drawer-toggle');

    // 如果抽屉是关闭的，点击打开它
    if ($('#rm_extensions_block').hasClass('closedDrawer')) {
        extensionsDrawer.trigger('click');
    }

    // 等待抽屉打开后滚动到我们的设置容器
    setTimeout(() => {
        // 找到我们的设置容器
        const container = $('#media_auto_generation_container');
        if (container.length) {
            console.log(`[${extensionName}] 滚动到设置容器`);
            // 滚动到设置面板位置
            $('#rm_extensions_block').animate(
                {
                    scrollTop:
                        container.offset().top -
                        $('#rm_extensions_block').offset().top +
                        $('#rm_extensions_block').scrollTop(),
                },
                500,
            );

            // 检查抽屉内容是否可见
            const drawerContent = container.find('.inline-drawer-content');
            const drawerHeader = container.find('.inline-drawer-header');

            // 只有当内容被隐藏时才触发展开
            if (drawerContent.is(':hidden') && drawerHeader.length) {
                drawerHeader.trigger('click');
            }
        }
    }, 500);
}

// 初始化扩展
$(function () {
    (async function () {
        console.log(`[${extensionName}] 正在初始化扩展`);
        
        // 获取设置HTML
        const settingsHtml = await $.get(
            `${extensionFolderPath}/settings.html`,
        );
        console.log(`[${extensionName}] 已加载设置HTML`);

        // 添加扩展到菜单
        $('#extensionsMenu')
            .append(`<div id="auto_generation" class="list-group-item flex-container flexGap5">
            <div class="fa-solid fa-film"></div>
            <span data-i18n="Media Auto Generation">Media Auto Generation</span>
        </div>`);

        // 修改点击事件，打开设置面板
        $('#auto_generation').off('click').on('click', onExtensionButtonClick);

        await loadSettings();

        // 创建设置
        await createSettings(settingsHtml);

        // 确保设置面板可见时，设置值是正确的
        $('#extensions-settings-button').on('click', function () {
            setTimeout(() => {
                updateUI();
            }, 200);
        });
    })();
});

/**
 * 核心处理逻辑：解析并生成媒体
 * @param {boolean} isFinal - 是否是最终检查（决定是否保存聊天等）
 */
async function processMessageContent(isFinal = false) {
    if (!extension_settings[extensionName] || extension_settings[extensionName].mediaType === 'disabled') {
        return;
    }

    const context = getContext();
    const messageIndex = context.chat.length - 1;
    const message = context.chat[messageIndex];

    if (!message || message.is_user || !message.mes) {
        return;
    }

    const mediaType = extension_settings[extensionName].mediaType;
    const regexStr = mediaType === 'image' 
        ? extension_settings[extensionName].imageRegex 
        : extension_settings[extensionName].videoRegex;

    if (!regexStr) {
        console.error(`[${extensionName}] 正则表达式设置未正确初始化`);
        return;
    }

    const mediaTagRegex = regexFromString(regexStr);
    
    let matches;
    if (mediaTagRegex.global) {
        matches = [...message.mes.matchAll(mediaTagRegex)];
    } else {
        const singleMatch = message.mes.match(mediaTagRegex);
        matches = singleMatch ? [singleMatch] : [];
    }
    
    // 如果没有匹配项，直接返回
    if (matches.length === 0) return;

    for (const match of matches) {
        const originalTag = match[0];
        
        // 【核心修复3】：绝对防御 (Absolute Defense)
        // 无论正则是什么，只要标签里已经有了 src=，就说明它已经被处理成了 img/video
        // 直接跳过，防止任何形式的递归或重复
        if (originalTag.includes('src=') || originalTag.includes('src =')) {
            continue;
        }
        
        const uniqueKey = originalTag.trim(); // 唯一标识符

        // -----------------------------------------------------------------
        // 【核心修复逻辑 1：缓存回填 (Cache Hit)】
        // -----------------------------------------------------------------
        if (generatedCache.has(uniqueKey)) {
            const cachedMediaTag = generatedCache.get(uniqueKey);
            
            // 只有当消息里依然包含原始标签时，才执行替换
            if (message.mes.includes(uniqueKey)) {
                console.log(`[${extensionName}] [DEBUG] 缓存命中 (流式回退检测)，重新应用替换: ${uniqueKey.substring(0, 15)}...`);
                message.mes = message.mes.replace(uniqueKey, cachedMediaTag);
                updateMessageBlock(messageIndex, message);
                
                // 如果是最终检查，保存聊天
                if (isFinal) {
                    await context.saveChat();
                }
            }
            continue; // 已经处理过，跳过后续生成逻辑
        }

        // -----------------------------------------------------------------
        // 【核心修复逻辑 2：生成中保护】
        // -----------------------------------------------------------------
        if (processingTags.has(uniqueKey)) {
            continue;
        }

        // -----------------------------------------------------------------
        // 【核心修复逻辑 4：Prompt 幂等性检查 (Idempotency)】
        // -----------------------------------------------------------------
        // 尝试提取 Prompt，用于防止同一条消息中因文本刷新导致的重复提交
        // 假设正则Group 2是Prompt，Group 1是Params。如果提取不到，做兼容处理
        let extractedPrompt = (match[2] || "").trim();
        if (!extractedPrompt && match[1] && !match[0].includes('light_intensity') && !match[0].includes('videoParams')) {
             extractedPrompt = match[1].trim();
        }

        if (extractedPrompt) {
            // 如果这个 prompt 在本次会话中已经记录过了，直接跳过
            if (currentSessionPrompts.has(extractedPrompt)) {
                console.log(`[${extensionName}] [拦截] 检测到重复 Prompt，跳过生成: ${extractedPrompt.substring(0, 10)}...`);
                continue;
            }
            // 标记此 prompt 已占用
            currentSessionPrompts.add(extractedPrompt);
        }

        // -----------------------------------------------------------------
        // 【开始新生成】
        // -----------------------------------------------------------------
        processingTags.add(uniqueKey);
        console.log(`[${extensionName}] [DEBUG] 开始新生成 (isFinal:${isFinal}): ${uniqueKey.substring(0, 30)}...`);

        (async () => {
            let timer;
            let seconds = 0;
            
            try {
                let originalPrompt = '';
                let originalVideoParams = '';
                let originalLightIntensity = '';
                let finalPrompt = '';

                // 解析逻辑...
                if (mediaType === 'video') {
                    originalVideoParams = typeof match?.[1] === 'string' ? match[1] : '';
                    originalPrompt = typeof match?.[2] === 'string' ? match[2] : '';
                    
                    if (originalVideoParams && originalVideoParams.trim()) {
                        const params = originalVideoParams.split(',');
                        if (params.length === 3) {
                            const [frameCount, width, height] = params;
                            const setvarString = `{{setvar::videoFrameCount::${frameCount}}}{{setvar::videoWidth::${width}}}{{setvar::videoHeight::${height}}}`;
                            finalPrompt = setvarString + originalPrompt;
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
                            
                            const setvarString = `{{setvar::light_intensity::${lightIntensity}}}{{setvar::sunshine_intensity::${sunshineIntensity}}}`;
                            finalPrompt = setvarString + originalPrompt;
                        } else {
                            finalPrompt = originalPrompt;
                        }
                    } else {
                        finalPrompt = originalPrompt;
                    }
                }
                
                if (!finalPrompt.trim()) {
                    processingTags.delete(uniqueKey);
                    // 如果Prompt无效，从已提交集合中移除，以免误伤
                    if(extractedPrompt) currentSessionPrompts.delete(extractedPrompt);
                    return;
                }

                // Toastr
                const mediaTypeText = mediaType === 'image' ? 'image' : 'video';
                const toastrOptions = { timeOut: 0, extendedTimeOut: 0, closeButton: true };
                const baseText = `生成 ${mediaTypeText} (${originalPrompt.substring(0, 10)}...)...`; 
                let toast = toastr.info(`${baseText} ${seconds}s`, '', toastrOptions);
                
                timer = setInterval(() => {
                    seconds++;
                    const $toastElement = $(`.toast-message:contains("${baseText}")`).closest('.toast');
                    if ($toastElement.length) {
                        $toastElement.find('.toast-message').text(`${baseText} ${seconds}s`);
                    } else {
                        clearInterval(timer);
                    }
                }, 1000);

                // 调用 SD
                const result = await SlashCommandParser.commands['sd'].callback(
                    { quiet: 'true' },
                    finalPrompt
                );
                
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
                    
                    // 【新逻辑 3】立即存入缓存
                    generatedCache.set(uniqueKey, mediaTag);

                    // 获取最新上下文
                    const currentContext = getContext();
                    const currentMsg = currentContext.chat[messageIndex];

                    if (currentMsg.mes.includes(uniqueKey)) {
                        currentMsg.mes = currentMsg.mes.replace(uniqueKey, mediaTag);
                        updateMessageBlock(messageIndex, currentMsg);
                        await eventSource.emit(event_types.MESSAGE_UPDATED, messageIndex);
                        
                        console.log(`[${extensionName}] [DEBUG] 生成并初次替换成功: ${uniqueKey.substring(0, 15)}...`);

                        if (isFinal) {
                            await currentContext.saveChat();
                        }
                    } else {
                         console.log(`[${extensionName}] [DEBUG] 生成成功但标签已从文本消失，已存缓存等待下次替换`);
                    }
                }

                clearInterval(timer);
                toastr.clear(toast);
                toastr.success(`成功生成 ${mediaTypeText}, 耗时 ${seconds}s`);

            } catch (error) {
                clearInterval(timer);
                toastr.error(`Media generation error: ${error}`);
                console.error(`[${extensionName}] [ERROR]`, error);
                
                // 失败了，从已提交Set中移除，允许重试
                if (finalPrompt && extractedPrompt) currentSessionPrompts.delete(extractedPrompt);

            } finally {
                // 无论成功失败，都解除锁定
                // 如果成功，它已经在 generatedCache 里了，下次走缓存逻辑
                processingTags.delete(uniqueKey);
            }
        })();
    }
}

// --- 事件监听注册 ---

// 封装防抖的最终检查，解决并发事件冲突 + 流式状态报警
const triggerFinalCheck = () => {
    if (finalCheckTimer) clearTimeout(finalCheckTimer);
    finalCheckTimer = setTimeout(() => {
        console.log(`[${extensionName}] [DEBUG] 执行防抖后的最终检查`);
        processMessageContent(true);
        
        // 【新功能】：检查流式设置是否匹配
        const pluginStreamSetting = extension_settings[extensionName]?.streamGeneration;
        
        // 如果插件开了流式，但全程没检测到Token流 (realStreamingDetected为false)
        if (pluginStreamSetting && !realStreamingDetected) {
            // 这里加个判断：只有当chat长度大于0时才报警，避免初始化时误报
            const context = getContext();
            if (context.chat && context.chat.length > 0) {
                 // 警告：建议使用 Console 警告或一次性 Toastr，Alert 可能会打断用户，
                 // 但根据你的需求，这里使用 alert。
                 // 为了防止每次生成都弹窗，可以加个标记或者只在特定条件下弹
                 console.warn("【Media Auto Gen】检测到开启了插件流式生成，但ST实际未流式传输。");
                 alert("【Media Auto Gen 警告】\n检测到您开启了插件的「流式生成」功能，但SillyTavern实际并未进行流式传输。\n\n请在SillyTavern的API设置中开启 Stream，或者关闭本插件的流式生成选项，否则可能导致图片重复生成或无法显示。");
            }
        } 
        // 如果插件关了流式，但检测到了Token流
        else if (!pluginStreamSetting && realStreamingDetected) {
            console.warn("【Media Auto Gen】检测到ST正在流式传输，但插件流式生成未开启。");
            alert("【Media Auto Gen 警告】\n检测到SillyTavern正在进行流式传输，但本插件的「流式生成」功能未开启。\n\n这会导致图片标签无法在生成过程中被解析，只能在最后显示。建议在插件设置中开启 Stream Generation。");
        }
        
    }, 300); // 300ms 延迟
};

// 1. 监听生成开始
eventSource.on(event_types.GENERATION_STARTED, () => {
    console.log(`EVENT GENERATION_STARTED`);
    
    // 重置流式检测标志
    realStreamingDetected = false;
    
    // 【重要】生成开始时，总是清空 Prompt 历史，允许新的生成尝试
    currentSessionPrompts.clear();

    if (!extension_settings[extensionName]?.streamGeneration) return;

    const context = getContext();
    // 防御性编程：确保 chat 数组不为空
    if (!context.chat || context.chat.length === 0) return;
    
    const newIndex = context.chat.length - 1;

    // 只有当消息索引改变时（新消息），才清空缓存
    // 如果是续写 (Auto-continue)，保留缓存
    if (newIndex !== currentProcessingIndex) {
        console.log(`[${extensionName}] [DEBUG] 检测到新消息 (Index: ${newIndex})，初始化缓存`);
        processingTags.clear();
        generatedCache.clear(); // 清空旧消息的缓存
        currentProcessingIndex = newIndex;
    } else {
        console.log(`[${extensionName}] [DEBUG] 检测到续写 (Index: ${newIndex})，保留缓存`);
    }

    isStreamActive = true;
    
    if (streamInterval) clearInterval(streamInterval);
    streamInterval = setInterval(() => {
        if (!isStreamActive) {
            clearInterval(streamInterval);
            return;
        }
        processMessageContent(false);
    }, 2000);
});

// 【新事件】：监听流式 Token 接收
eventSource.on(event_types.STREAM_TOKEN_RECEIVED, () => {
    realStreamingDetected = true;
});

// 2. 监听生成结束
const onGenerationFinished = async () => {
    console.log(`EVENT MESSAGE_FIN`);

    if (streamInterval) {
        clearInterval(streamInterval);
        streamInterval = null;
    }

    if (isStreamActive) {
        isStreamActive = false;
        console.log(`[${extensionName}] [DEBUG] 生成流结束，准备最终检查`);
        // 使用防抖触发，代替原来的 setTimeout
        triggerFinalCheck();
    } else {
        // 非流式模式结束，也触发检查（用于报警检测等）
        triggerFinalCheck();
    }
};

eventSource.on(event_types.GENERATION_ENDED, onGenerationFinished);
eventSource.on(event_types.GENERATION_STOPPED, onGenerationFinished);

// 3. 监听消息接收 - 兜底逻辑
eventSource.on(event_types.MESSAGE_RECEIVED, async () => {
    console.log(`EVENT MESSAGE_RECEIVED`);
    const context = getContext();
    if (!context.chat || context.chat.length === 0) return;
    const newIndex = context.chat.length - 1;

    // 非流式模式下的缓存管理，或者索引发生了变化
    if (!extension_settings[extensionName]?.streamGeneration || newIndex !== currentProcessingIndex) {
        if (newIndex !== currentProcessingIndex) {
            processingTags.clear();
            generatedCache.clear();
            currentSessionPrompts.clear(); // 【回答你的问题】：换新消息了，清空Prompt记录
            currentProcessingIndex = newIndex;
        }
    }
    
    // 同样走防抖检查
    triggerFinalCheck();
});
