// 媒体自动生成插件主脚本
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

// 插入类型常量 - 只保留REPLACE模式
const INSERT_TYPE = {
    REPLACE: 'replace',
};

// --- 全局状态管理 (流式生成专用) ---
let isStreamActive = false;     // 标记流是否正在进行
let streamInterval = null;      // 定时器引用
const processingTags = new Set(); // 正在生成的标签（防止重复提交）
// 缓存 Map：键为原始标签字符串，值为已生成好的 HTML 标签
const generatedCache = new Map(); 
let currentProcessingIndex = -1; // 记录当前处理的消息索引

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
    if ($('#mediaType').length) {
        $('#mediaType').val(extension_settings[extensionName].mediaType);
        $('#image_regex').val(extension_settings[extensionName].imageRegex);
        $('#video_regex').val(extension_settings[extensionName].videoRegex);
        $('#media_style').val(extension_settings[extensionName].style);
        $('#stream_generation').prop('checked', extension_settings[extensionName].streamGeneration ?? false);
    }
}

// 加载设置
async function loadSettings() {
    console.log(`[${extensionName}] 正在加载设置`);
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    if (Object.keys(extension_settings[extensionName]).length === 0) {
        console.log(`[${extensionName}] 未找到现有设置，使用默认设置`);
        Object.assign(extension_settings[extensionName], defaultSettings);
    } else {
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
    if (!$('#media_auto_generation_container').length) {
        $('#extensions_settings2').append(
            '<div id="media_auto_generation_container" class="extension_container"></div>',
        );
    }
    $('#media_auto_generation_container').empty().append(settingsHtml);

    $('#mediaType').on('change', function () {
        const newValue = $(this).val();
        console.log(`[${extensionName}] 媒体类型已更改为: ${newValue}`);
        extension_settings[extensionName].mediaType = newValue;
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

    $('#stream_generation').on('change', function () {
        const newValue = $(this).prop('checked');
        console.log(`[${extensionName}] 流式生成设置已更新: ${newValue}`);
        extension_settings[extensionName].streamGeneration = newValue;
        saveSettingsDebounced();
    });

    updateUI();
}

// 设置面板点击处理函数
function onExtensionButtonClick() {
    const extensionsDrawer = $('#extensions-settings-button .drawer-toggle');
    if ($('#rm_extensions_block').hasClass('closedDrawer')) {
        extensionsDrawer.trigger('click');
    }
    setTimeout(() => {
        const container = $('#media_auto_generation_container');
        if (container.length) {
            $('#rm_extensions_block').animate(
                {
                    scrollTop: container.offset().top - $('#rm_extensions_block').offset().top + $('#rm_extensions_block').scrollTop(),
                },
                500,
            );
            const drawerContent = container.find('.inline-drawer-content');
            const drawerHeader = container.find('.inline-drawer-header');
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
        const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
        console.log(`[${extensionName}] 已加载设置HTML`);
        $('#extensionsMenu').append(`<div id="auto_generation" class="list-group-item flex-container flexGap5">
            <div class="fa-solid fa-film"></div>
            <span data-i18n="Media Auto Generation">Media Auto Generation</span>
        </div>`);
        $('#auto_generation').off('click').on('click', onExtensionButtonClick);
        await loadSettings();
        await createSettings(settingsHtml);
        $('#extensions-settings-button').on('click', function () {
            setTimeout(() => { updateUI(); }, 200);
        });
    })();
});

/**
 * 【新功能】直接 DOM 补丁函数
 * 用于流式传输中无闪烁地替换内容
 */
function quickPatchMessageBody(messageIndex, uniqueKey, mediaTag) {
    // 找到对应消息的文本容器
    // SillyTavern 的消息 div id 通常是 message_<index>，文本在 .mes_text 中
    const $msgTextDiv = $(`#message_${messageIndex} .mes_text`);
    
    if ($msgTextDiv.length) {
        // 获取当前 DOM 中的 HTML
        const currentHtml = $msgTextDiv.html();
        
        // 如果 DOM 里还包含原始的 uniqueKey (即原始标签)，则进行替换
        if (currentHtml && currentHtml.includes(uniqueKey)) {
            // 使用 replace 进行字符串替换，这比 updateMessageBlock 轻量得多，不会重排整个布局
            const newHtml = currentHtml.replace(uniqueKey, mediaTag);
            $msgTextDiv.html(newHtml);
        }
    }
}

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
        const uniqueKey = originalTag.trim(); 

        // -----------------------------------------------------------------
        // 【逻辑 1：缓存回填】
        // -----------------------------------------------------------------
        if (generatedCache.has(uniqueKey)) {
            const cachedMediaTag = generatedCache.get(uniqueKey);
            
            // 只有当消息文本里包含原始标签时，才需要替换
            if (message.mes.includes(uniqueKey)) {
                // 1. 更新内存中的聊天记录 (Model)
                message.mes = message.mes.replace(uniqueKey, cachedMediaTag);
                
                // 2. 更新 UI (View)
                if (isFinal) {
                    // 最终阶段：使用标准方法，确保Markdown格式完美，保存聊天
                    updateMessageBlock(messageIndex, message);
                    await context.saveChat();
                } else {
                    // 【防闪烁关键】：流式阶段，使用轻量级 DOM 补丁
                    quickPatchMessageBody(messageIndex, uniqueKey, cachedMediaTag);
                }
            }
            continue;
        }

        // -----------------------------------------------------------------
        // 【逻辑 2：生成中保护】
        // -----------------------------------------------------------------
        if (processingTags.has(uniqueKey)) {
            continue;
        }

        // -----------------------------------------------------------------
        // 【逻辑 3：新生成】
        // -----------------------------------------------------------------
        processingTags.add(uniqueKey);
        console.log(`[${extensionName}] [DEBUG] 开始新生成: ${uniqueKey.substring(0, 30)}...`);

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
                    return;
                }

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
                        mediaTag = `<img src="${escapedUrl}" ${originalLightIntensity ? `light_intensity="${escapedLightIntensity}"` : 'light_intensity="0"'} prompt="${escapedOriginalPrompt}" style="${style}" onclick="window.open(this.src)" />`;
                    }
                    
                    // 存入缓存
                    generatedCache.set(uniqueKey, mediaTag);

                    const currentContext = getContext();
                    const currentMsg = currentContext.chat[messageIndex];

                    if (currentMsg.mes.includes(uniqueKey)) {
                        currentMsg.mes = currentMsg.mes.replace(uniqueKey, mediaTag);
                        
                        // 【防闪烁关键】
                        if (isFinal) {
                            updateMessageBlock(messageIndex, currentMsg);
                            await eventSource.emit(event_types.MESSAGE_UPDATED, messageIndex);
                            await currentContext.saveChat();
                        } else {
                            // 流式生成中，使用 DOM 补丁，不刷新整个块
                            quickPatchMessageBody(messageIndex, uniqueKey, mediaTag);
                            // 依然通知消息更新，但不保存文件
                            await eventSource.emit(event_types.MESSAGE_UPDATED, messageIndex);
                        }
                        
                        console.log(`[${extensionName}] [DEBUG] 生成并替换成功`);
                    }
                }

                clearInterval(timer);
                toastr.clear(toast);
                toastr.success(`成功生成 ${mediaTypeText}, 耗时 ${seconds}s`);

            } catch (error) {
                clearInterval(timer);
                toastr.error(`Media generation error: ${error}`);
                console.error(`[${extensionName}] [ERROR]`, error);
            } finally {
                processingTags.delete(uniqueKey);
            }
        })();
    }
}

// --- 事件监听注册 ---

// 1. 监听生成开始
eventSource.on(event_types.GENERATION_STARTED, () => {
        console.log('EVENT GENERATION_STARTED')

    if (!extension_settings[extensionName]?.streamGeneration) return;

    const context = getContext();
    if (!context.chat || context.chat.length === 0) return;
    
    const newIndex = context.chat.length - 1;

    if (newIndex !== currentProcessingIndex) {
        console.log(`[${extensionName}] [DEBUG] 新消息 (Index: ${newIndex})，初始化`);
        processingTags.clear();
        generatedCache.clear();
        currentProcessingIndex = newIndex;
    }

    isStreamActive = true;
    
    if (streamInterval) clearInterval(streamInterval);
    // 【优化】缩短轮询间隔到 200ms，配合 DOM 补丁，实现近乎实时的回填
    streamInterval = setInterval(() => {
        if (!isStreamActive) {
            clearInterval(streamInterval);
            return;
        }
        processMessageContent(false);
    }, 200);
});

// 2. 监听生成结束
const onGenerationFinished = async () => {
        console.log('EVENT MESSAGE_fin')

    if (streamInterval) {
        clearInterval(streamInterval);
        streamInterval = null;
    }

    if (isStreamActive) {
        isStreamActive = false;
        console.log(`[${extensionName}] [DEBUG] 生成结束，执行最终渲染`);
        setTimeout(() => processMessageContent(true), 200);
    }
};

eventSource.on(event_types.GENERATION_ENDED, onGenerationFinished);
eventSource.on(event_types.GENERATION_STOPPED, onGenerationFinished);

// 3. 监听消息接收
eventSource.on(event_types.MESSAGE_RECEIVED, async () => {
    console.log('EVENT MESSAGE_RECEIVED')
    const context = getContext();
    if (!context.chat || context.chat.length === 0) return;
    const newIndex = context.chat.length - 1;

    if (!extension_settings[extensionName]?.streamGeneration) {
        if (newIndex !== currentProcessingIndex) {
            processingTags.clear();
            generatedCache.clear();
            currentProcessingIndex = newIndex;
        }
    }
    
    await processMessageContent(true);
});
