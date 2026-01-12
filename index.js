// 媒体自动生成插件主脚本 - 最终优化版
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

// 插入类型常量
const INSERT_TYPE = {
    REPLACE: 'replace',
};

// --- 全局状态管理 ---
let isStreamActive = false;      // 标记流是否正在进行
let streamInterval = null;       // 定时器引用
const processingTags = new Set(); // 正在生成的标签（防止并发）

// 【核心修复1】：缓存 Map。键为原始标签字符串，值为已生成好的 HTML 标签
const generatedCache = new Map(); 

let currentProcessingIndex = -1; // 记录当前处理的消息索引

// 【核心修复2】：本次生成会话中已提交过的 Prompt 集合
// 作用：幂等性检查，防止同一次生成中因文本波动导致重复提交
const currentSessionPrompts = new Set();

// 【新功能】：实际流式状态检测
let realStreamingDetected = false; // 标记本次生成是否检测到了流式Token

// 防抖计时器
let finalCheckTimer = null;

/**
 * 转义HTML属性值中的特殊字符
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
    mediaType: 'disabled',
    imageRegex: '/<img\\b(?:(?:(?!\\bprompt\\b)[^>])*\\blight_intensity\\s*=\\s*"([^"]*)")?(?:(?!\\bprompt\\b)[^>])*\\bprompt\\s*=\\s*"([^"]*)"[^>]*>/gi',
    videoRegex: '/<video\b(?:(?:(?!\bprompt\b)[^>])*\bvideoParams\s*=\s*"([^"]*)")?(?:(?!\bprompt\b)[^>])*\bprompt\s*=\s*"([^"]*)"[^>]*>/gi',
    style: 'width:auto;height:auto',
    streamGeneration: false, 
};

// 更新UI
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

// 创建设置页面
async function createSettings(settingsHtml) {
    if (!$('#media_auto_generation_container').length) {
        $('#extensions_settings2').append(
            '<div id="media_auto_generation_container" class="extension_container"></div>',
        );
    }
    $('#media_auto_generation_container').empty().append(settingsHtml);

    $('#mediaType').on('change', function () {
        const newValue = $(this).val();
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
        extension_settings[extensionName].imageRegex = $(this).val();
        saveSettingsDebounced();
    });

    $('#video_regex').on('input', function () {
        extension_settings[extensionName].videoRegex = $(this).val();
        saveSettingsDebounced();
    });

    $('#media_style').on('input', function () {
        extension_settings[extensionName].style = $(this).val();
        saveSettingsDebounced();
    });

    $('#stream_generation').on('change', function () {
        const newValue = $(this).prop('checked');
        extension_settings[extensionName].streamGeneration = newValue;
        saveSettingsDebounced();
    });

    updateUI();
}

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
        const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
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
 * 核心处理逻辑：解析并生成媒体
 * @param {boolean} isFinal - 是否是最终检查
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
        
        // 【核心修复3】：绝对防御
        // 如果标签中已经包含了 'src='，说明已经被处理过，直接跳过
        if (originalTag.includes('src=') || originalTag.includes('src =')) {
            continue;
        }

        const uniqueKey = originalTag.trim();

        // 1. 缓存回填 (处理流式回滚)
        if (generatedCache.has(uniqueKey)) {
            const cachedMediaTag = generatedCache.get(uniqueKey);
            if (message.mes.includes(uniqueKey)) {
                console.log(`[${extensionName}] [DEBUG] 缓存命中，重新应用: ${uniqueKey.substring(0, 15)}...`);
                message.mes = message.mes.replace(uniqueKey, cachedMediaTag);
                updateMessageBlock(messageIndex, message);
                if (isFinal) {
                    await context.saveChat();
                }
            }
            continue;
        }

        // 2. 并发保护
        if (processingTags.has(uniqueKey)) {
            continue;
        }

        // 【核心修复4】：Prompt 幂等性检查
        // 提取 Prompt (假设正则Group 2是Prompt，Group 1是Params，如果提取不到尝试降级处理)
        let extractedPrompt = (match[2] || "").trim();
        if (!extractedPrompt && match[1] && !match[0].includes('light_intensity') && !match[0].includes('videoParams')) {
             extractedPrompt = match[1].trim();
        }
        
        // 如果提取到了 prompt，检查本次会话是否已处理过
        if (extractedPrompt) {
            if (currentSessionPrompts.has(extractedPrompt)) {
                console.log(`[${extensionName}] [拦截] 检测到重复 Prompt，跳过: ${extractedPrompt.substring(0, 10)}...`);
                continue;
            }
            // 标记此 prompt 已占用
            currentSessionPrompts.add(extractedPrompt);
        }

        // 开始生成流程
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

                // 解析逻辑
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
                    
                    generatedCache.set(uniqueKey, mediaTag);

                    const currentContext = getContext();
                    const currentMsg = currentContext.chat[messageIndex];

                    if (currentMsg.mes.includes(uniqueKey)) {
                        currentMsg.mes = currentMsg.mes.replace(uniqueKey, mediaTag);
                        updateMessageBlock(messageIndex, currentMsg);
                        await eventSource.emit(event_types.MESSAGE_UPDATED, messageIndex);
                        
                        if (isFinal) {
                            await currentContext.saveChat();
                        }
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
                if (finalPrompt) currentSessionPrompts.delete(finalPrompt);
            } finally {
                processingTags.delete(uniqueKey);
            }
        })();
    }
}

// --- 事件监听注册 ---

// 封装防抖的最终检查，解决并发事件冲突
const triggerFinalCheck = () => {
    if (finalCheckTimer) clearTimeout(finalCheckTimer);
    finalCheckTimer = setTimeout(() => {
        console.log(`[${extensionName}] [DEBUG] 执行防抖后的最终检查`);
        processMessageContent(true);
        
        // 【新功能】：检查流式设置是否匹配
        const pluginStreamSetting = extension_settings[extensionName]?.streamGeneration;
        
        // 只有当实际上有内容生成（或者尝试生成）时才检查，避免空消息打扰
        // 或者直接检查状态
        if (pluginStreamSetting && !realStreamingDetected) {
            // 插件开了流式，但没检测到 Token 流 (可能是文本生成模式不支持，或者ST没开流)
            alert("【Media Auto Gen 警告】\n检测到您开启了插件的「流式生成」功能，但SillyTavern实际并未进行流式传输。\n\n请在SillyTavern的API设置中开启 Stream，或者关闭本插件的流式生成选项，否则可能导致图片重复生成或无法显示。");
        } else if (!pluginStreamSetting && realStreamingDetected) {
            // 插件关了流式，但检测到了 Token 流
            alert("【Media Auto Gen 警告】\n检测到SillyTavern正在进行流式传输，但本插件的「流式生成」功能未开启。\n\n这会导致图片标签无法在生成过程中被解析，只能在最后显示。建议在插件设置中开启 Stream Generation。");
        }
        
    }, 300);
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
    if (!context.chat || context.chat.length === 0) return;
    
    const newIndex = context.chat.length - 1;

    // 如果是新消息索引，清空缓存
    if (newIndex !== currentProcessingIndex) {
        console.log(`[${extensionName}] [DEBUG] 检测到新消息 (Index: ${newIndex})，初始化缓存`);
        processingTags.clear();
        generatedCache.clear();
        currentProcessingIndex = newIndex;
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

// 【新事件监听】：监听流式 Token 接收，用于判断是否真的在流式传输
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

    isStreamActive = false;
    // 使用防抖触发最终检查和报警
    triggerFinalCheck();
};

eventSource.on(event_types.GENERATION_ENDED, onGenerationFinished);
eventSource.on(event_types.GENERATION_STOPPED, onGenerationFinished);

// 3. 监听消息接收 - 兜底逻辑
eventSource.on(event_types.MESSAGE_RECEIVED, async () => {
    console.log(`EVENT MESSAGE_RECEIVED`);
    
    const context = getContext();
    if (!context.chat || context.chat.length === 0) return;
    const newIndex = context.chat.length - 1;

    // 如果在非流式模式下，或者由于某种原因索引变了，清理状态
    if (newIndex !== currentProcessingIndex) {
        processingTags.clear();
        generatedCache.clear();
        currentSessionPrompts.clear(); // 【回答你的问题】：换新消息了，这里也得清
        currentProcessingIndex = newIndex;
    }
    
    // 同样走防抖检查
    triggerFinalCheck();
});
