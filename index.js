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
    // 确保设置对象存在且未被禁用
    if (!extension_settings[extensionName] || extension_settings[extensionName].mediaType === 'disabled') {
        return;
    }

    const context = getContext();
    const messageIndex = context.chat.length - 1;
    const message = context.chat[messageIndex];

    // 检查是否是AI消息
    if (!message || message.is_user || !message.mes) {
        return;
    }

    // 获取当前媒体类型和对应正则
    const mediaType = extension_settings[extensionName].mediaType;
    const regexStr = mediaType === 'image' 
        ? extension_settings[extensionName].imageRegex 
        : extension_settings[extensionName].videoRegex;

    // 确保正则属性存在
    if (!regexStr) {
        console.error(`[${extensionName}] 正则表达式设置未正确初始化`);
        return;
    }

    // 使用正则表达式搜索
    const mediaTagRegex = regexFromString(regexStr);
    
    // 【正则兼容性】检查是否包含 global 标志
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
        const uniqueKey = originalTag.trim(); // 使用标签原始内容作为唯一标识

        // 【去重逻辑】
        // 1. 如果该标签正在生成中 (processingTags)，跳过
        // 2. 如果该标签已经处理并替换完毕 (processedTags)，跳过
        // 3. (双重保险) 检查消息内容中是否还包含原始标签，如果不包含说明已经被替换了
        if (processingTags.has(uniqueKey) || processedTags.has(uniqueKey)) {
            continue;
        }

        // 锁定当前标签
        processingTags.add(uniqueKey);
        console.log(`[${extensionName}] [DEBUG] 开始处理标签 (isFinal:${isFinal}): ${uniqueKey.substring(0, 30)}...`);

        // 异步处理，避免阻塞
        // 注意：这里我们立即执行一个异步函数，不使用 await 阻塞循环，实现并发生成
        (async () => {
            let timer;
            let seconds = 0;
            
            try {
                let originalPrompt = '';
                let originalVideoParams = '';
                let originalLightIntensity = '';
                let finalPrompt = '';

                // 根据媒体类型处理不同的捕获组
                if (mediaType === 'video') {
                    // 视频类型：match[1] 是 videoParams，match[2] 是 prompt
                    originalVideoParams = typeof match?.[1] === 'string' ? match[1] : '';
                    originalPrompt = typeof match?.[2] === 'string' ? match[2] : '';
                
                    console.log(`[${extensionName}] [DEBUG] 提取的视频参数: originalVideoParams="${originalVideoParams}", originalPrompt="${originalPrompt}"`);
                    
                    // 处理 videoParams
                    if (originalVideoParams && originalVideoParams.trim()) {
                        const params = originalVideoParams.split(',');
                        if (params.length === 3) {
                            const [frameCount, width, height] = params;
                            const setvarString = `{{setvar::videoFrameCount::${frameCount}}}{{setvar::videoWidth::${width}}}{{setvar::videoHeight::${height}}}`;
                            finalPrompt = setvarString + originalPrompt;
                        } else {
                            console.warn(`[${extensionName}] videoParams 格式错误`);
                            finalPrompt = originalPrompt;
                        }
                    } else {
                        finalPrompt = originalPrompt;
                    }
                } else {
                    // 图片逻辑
                    originalLightIntensity = typeof match?.[1] === 'string' ? match[1] : ''; // Capture Group 1
                    originalPrompt = typeof match?.[2] === 'string' ? match[2] : ''; // Capture Group 2
                    
                    console.log(`[${extensionName}] [DEBUG] 提取的图片参数: originalLightIntensity="${originalLightIntensity}", originalPrompt="${originalPrompt}"`);
                    
                    // 处理 lightIntensity
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
                            console.warn(`[${extensionName}] lightIntensity 格式错误`);
                            finalPrompt = originalPrompt;
                        }
                    } else {
                        finalPrompt = originalPrompt;
                    }
                }
                
                if (!finalPrompt.trim()) {
                    console.log(`[${extensionName}] [DEBUG] 提示词为空，跳过生成`);
                    processingTags.delete(uniqueKey);
                    return;
                }

                // --- Toastr 进度提示逻辑 (保持原有体验) ---
                const mediaTypeText = mediaType === 'image' ? 'image' : 'video';
                const toastrOptions = { timeOut: 0, extendedTimeOut: 0, closeButton: true };
                // 使用唯一标识的一部分作为 baseText，防止多个生成任务混淆
                const baseText = `生成 ${mediaTypeText} (${originalPrompt.substring(0, 10)}...)...`; 
                let toast = toastr.info(`${baseText} ${seconds}s`, '', toastrOptions);
                
                timer = setInterval(() => {
                    seconds++;
                    // 查找对应的 toast 元素
                    const $toastElement = $(`.toast-message:contains("${baseText}")`).closest('.toast');
                    if ($toastElement.length) {
                        $toastElement.find('.toast-message').text(`${baseText} ${seconds}s`);
                    } else {
                        clearInterval(timer);
                    }
                }, 1000);

                console.log(`[${extensionName}] [DEBUG] 调用SD生成，Prompt: ${finalPrompt.substring(0, 50)}...`);

                // --- 调用 SD 生成 ---
                const result = await SlashCommandParser.commands['sd'].callback(
                    { quiet: 'true' },
                    finalPrompt
                );
                
                console.log(`[${extensionName}] [DEBUG] 媒体生成结果 URL:`, result);

                if (typeof result === 'string' && result.trim().length > 0) {
                    // 获取样式
                    const style = extension_settings[extensionName].style || '';
                    
                    // 转义URL和原始prompt
                    const escapedUrl = escapeHtmlAttribute(result);
                    const escapedOriginalPrompt = originalPrompt;
                    
                    // 创建媒体标签
                    let mediaTag;
                    if (mediaType === 'video') {
                        const escapedVideoParams = originalVideoParams ? escapeHtmlAttribute(originalVideoParams) : '';
                        mediaTag = `<video src="${escapedUrl}" ${originalVideoParams ? `videoParams="${escapedVideoParams}"` : ''} prompt="${escapedOriginalPrompt}" style="${style}" loop controls autoplay muted/>`;
                    } else {
                        const escapedLightIntensity = originalLightIntensity ? escapeHtmlAttribute(originalLightIntensity) : '0';
                        mediaTag = `<img src="${escapedUrl}" ${originalLightIntensity ? `light_intensity="${escapedLightIntensity}"` : 'light_intensity="0"'} prompt="${escapedOriginalPrompt}" style="${style}" onclick="window.open(this.src)" />`;
                    }
                    
                    // 【重新获取上下文】因为是异步生成，消息内容可能已经变化
                    const currentContext = getContext();
                    const currentMsg = currentContext.chat[messageIndex];

                    // 只有当消息里还包含原始标签时才替换
                    if (currentMsg.mes.includes(uniqueKey)) {
                        currentMsg.mes = currentMsg.mes.replace(uniqueKey, mediaTag);

                        // 更新消息显示（会造成一次重绘，展示图片必须步骤）
                        updateMessageBlock(messageIndex, currentMsg);
                        
                        // 【事件通知】告知其他插件消息已变动
                        await eventSource.emit(event_types.MESSAGE_UPDATED, messageIndex);
                        
                        // 标记为已处理
                        processedTags.add(uniqueKey);
                        
                        console.log(`[${extensionName}] [DEBUG] 媒体替换成功`);

                        // 【IO安全检查】只在最终检查时保存聊天，避免流式过程中卡顿
                        if (isFinal) {
                            await currentContext.saveChat();
                            console.log(`[${extensionName}] [DEBUG] 最终生成完成，聊天已保存`);
                        }
                    }
                }

                // 清理 Timer 和 Toast
                clearInterval(timer);
                toastr.clear(toast);
                toastr.success(`成功生成 ${mediaTypeText}, 耗时 ${seconds}s`);

            } catch (error) {
                clearInterval(timer);
                toastr.error(`Media generation error: ${error}`);
                console.error(`[${extensionName}] [ERROR] 媒体生成错误:`, error);
            } finally {
                // 解锁，但如果是成功的，processedTags 已经记录了，不会再次触发
                processingTags.delete(uniqueKey);
            }
        })();
    }
}

// --- 事件监听注册 ---

// 1. 监听生成开始 (GENERATION_STARTED)
eventSource.on(event_types.GENERATION_STARTED, () => {
                    console.log(`EVENT GENERATION_STARTED`);

    // 检查是否开启了流式生成
    if (!extension_settings[extensionName]?.streamGeneration) {
        return;
    }

    console.log(`[${extensionName}] [DEBUG] 生成开始，启动流式轮询`);
    isStreamActive = true;
    
    // 清空缓存，准备处理新一轮消息
    processingTags.clear();
    processedTags.clear();

    // 清除可能存在的旧定时器
    if (streamInterval) clearInterval(streamInterval);

    // 启动定时器，每 2 秒检测一次
    streamInterval = setInterval(() => {
        if (!isStreamActive) {
            clearInterval(streamInterval);
            return;
        }
        processMessageContent(false); // isFinal = false，流式进行中
    }, 2000);
});

// 2. 监听生成结束 (GENERATION_ENDED 和 GENERATION_STOPPED)
const onGenerationFinished = async () => {
                console.log(`EVENT GENERATION_FIN`);

    // 清除定时器
    if (streamInterval) {
        clearInterval(streamInterval);
        streamInterval = null;
    }

    // 如果之前是活跃状态，执行最后一次检查
    if (isStreamActive) {
        isStreamActive = false;
        console.log(`[${extensionName}] [DEBUG] 生成结束，执行最终检查`);
        // 稍微延迟，确保文本完全写入
        setTimeout(() => processMessageContent(true), 200); // isFinal = true
    }
};

eventSource.on(event_types.GENERATION_ENDED, onGenerationFinished);
eventSource.on(event_types.GENERATION_STOPPED, onGenerationFinished);

// 3. 监听消息接收 (MESSAGE_RECEIVED) - 兜底逻辑
eventSource.on(event_types.MESSAGE_RECEIVED, async () => { 
            console.log(`EVENT MESSAGE_RECEIVED`);

    // 如果未开启流式生成，或者作为双重保险
    if (!extension_settings[extensionName]?.streamGeneration) {
        console.log(`[${extensionName}] [DEBUG] 收到消息事件 (非流式模式)`);
        await processMessageContent(true);
    } else {
        // 即使流式开启，也可以再做一次确保
        // 因为 processedTags 存在，所以不会重复生成
        await processMessageContent(true);
    }
});
