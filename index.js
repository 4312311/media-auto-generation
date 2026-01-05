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
const processedTags = new Set();  // 已经完成替换的标签（防止最终检查时重复替换）
let currentProcessingIndex = -1; // 【修复】记录当前处理的消息索引，用于识别续写

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
    
    if (matches.length === 0) return;

    for (const match of matches) {
        const originalTag = match[0];
        const uniqueKey = originalTag.trim(); 

        // 【去重核心】
        // 1. 如果 processingTags 包含它，说明正在生成，跳过。
        // 2. 如果 processedTags 包含它，说明【本次会话中】已经生成过，跳过。
        // 注意：因为我们现在在 GENERATION_STARTED 中保留了 processedTags（如果是续写），
        // 所以这里能正确拦截之前已经生成过的第一张图。
        if (processingTags.has(uniqueKey) || processedTags.has(uniqueKey)) {
            // console.log(`[${extensionName}] [DEBUG] 跳过已存在的标签: ${uniqueKey.substring(0, 10)}...`);
            continue;
        }

        // 锁定当前标签
        processingTags.add(uniqueKey);
        console.log(`[${extensionName}] [DEBUG] 发现新标签，开始生成 (isFinal:${isFinal}): ${uniqueKey.substring(0, 30)}...`);

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
                    
                    // 获取最新上下文
                    const currentContext = getContext();
                    const currentMsg = currentContext.chat[messageIndex];

                    if (currentMsg.mes.includes(uniqueKey)) {
                        currentMsg.mes = currentMsg.mes.replace(uniqueKey, mediaTag);
                        updateMessageBlock(messageIndex, currentMsg);
                        await eventSource.emit(event_types.MESSAGE_UPDATED, messageIndex);
                        
                        // 标记为已完成
                        processedTags.add(uniqueKey);
                        console.log(`[${extensionName}] [DEBUG] 生成完成: ${uniqueKey.substring(0, 15)}...`);

                        if (isFinal) {
                            await currentContext.saveChat();
                        }
                    } else {
                         // 特殊情况：如果消息里找不到key了（可能被替换了，或者被截断了），我们也标记为完成，防止死循环
                         processedTags.add(uniqueKey);
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
    const newIndex = context.chat.length - 1;

    // 【修复核心】：
    // 只有当消息索引改变时（说明是新的一轮对话），才清空缓存。
    // 如果索引没变（说明是自动续写/Auto-continue），保留缓存，这样就记得"第一张图已经生成过了"。
    if (newIndex !== currentProcessingIndex) {
        console.log(`[${extensionName}] [DEBUG] 检测到新消息 (Index: ${newIndex})，清空缓存`);
        processingTags.clear();
        processedTags.clear();
        currentProcessingIndex = newIndex;
    } else {
        console.log(`[${extensionName}] [DEBUG] 检测到消息续写 (Index: ${newIndex})，保留缓存`);
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

// 2. 监听生成结束
const onGenerationFinished = async () => {
          console.log('EVENT GENERATION_FIN')

    if (streamInterval) {
        clearInterval(streamInterval);
        streamInterval = null;
    }

    if (isStreamActive) {
        isStreamActive = false;
        console.log(`[${extensionName}] [DEBUG] 生成流结束，执行最终检查`);
        // 这里不重置 currentProcessingIndex，因为 MESSAGE_RECEIVED 可能会紧接着触发
        // 或者用户可能会手动再次续写
        setTimeout(() => processMessageContent(true), 200);
    }
};

eventSource.on(event_types.GENERATION_ENDED, onGenerationFinished);
eventSource.on(event_types.GENERATION_STOPPED, onGenerationFinished);

// 3. 监听消息接收 - 兜底逻辑
eventSource.on(event_types.MESSAGE_RECEIVED, async () => {
              console.log('EVENT MESSAGE_RECEIVED')

    // 即使流式开启，这里也做一个最终检查
    // 此时 context 已经确定，且 processedTags 依然保留了状态
    if (extension_settings[extensionName]?.streamGeneration) {
        await processMessageContent(true);
    } else {
        // 非流式模式
        const context = getContext();
        const newIndex = context.chat.length - 1;
        // 非流式模式下，每次收到消息都视为新的（或者需要重置）
        // 因为非流式没有 STARTED 事件来设置 index
        if (newIndex !== currentProcessingIndex) {
            processingTags.clear();
            processedTags.clear();
            currentProcessingIndex = newIndex;
        }
        await processMessageContent(true);
    }
});
