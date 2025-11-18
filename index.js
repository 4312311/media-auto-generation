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
    imageRegex: '/<[\\s\\r\\n]*img[^>]*?prompt\\s*=\\s*"([^"]*?(?:,(?=[^"]*$)[^"j]*)?)"[^>]*?>/gis',
    videoRegex: '/<[\\s\\r\\n]*video[^>]*?prompt\\s*=\\s*"([^"]*?(?:,(?=[^"]*$)[^"j]*)?)"[^>]*?>/gis',
    style: 'width:auto;height:auto', // 默认图片样式
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

// 监听消息接收事件
eventSource.on(event_types.MESSAGE_RECEIVED, handleIncomingMessage);
async function handleIncomingMessage() {
    console.log(`[${extensionName}] 收到新消息事件`);
    
    // 确保设置对象存在且未被禁用
    if (!extension_settings[extensionName] || extension_settings[extensionName].mediaType === 'disabled') {
        console.log(`[${extensionName}] 插件已禁用或未找到设置，终止处理`);
        return;
    }

    const context = getContext();
    const message = context.chat[context.chat.length - 1];

    // 检查是否是AI消息
    if (!message || message.is_user) {
        console.log(`[${extensionName}] 消息来自用户，跳过处理`);
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
    console.log(`[${extensionName}] 使用正则表达式:`, mediaTagRegex);
    
    let matches;
    if (mediaTagRegex.global) {
        matches = [...message.mes.matchAll(mediaTagRegex)];
    } else {
        const singleMatch = message.mes.match(mediaTagRegex);
        matches = singleMatch ? [singleMatch] : [];
    }
    
    console.log(`[${extensionName}] 找到${matches.length}个匹配项`);
    
    if (matches.length > 0) {
        // 延迟执行媒体生成，确保消息首先显示出来
        setTimeout(async () => {
            let timer;
            let seconds = 0;

            try {
                console.log(`[${extensionName}] 开始生成${matches.length}个媒体项`);
                
                const mediaTypeText = mediaType === 'image' ? 'image' : 'video';
                const toastrOptions = {
                    timeOut: 0,
                    extendedTimeOut: 0,
                    closeButton: true
                };
                
                // 初始提示文本（用于定位提示框）
                const baseText = `开始生成 ${matches.length} ${mediaTypeText}...`;
                let toast = toastr.info(`${baseText} ${seconds}s`, '', toastrOptions);
                console.log(`[${extensionName}] 生成初始提示框，文本: ${baseText} ${seconds}s`);
                
                // 启动定时器：通过文本特征定位提示框（不依赖data-toastr）
                timer = setInterval(() => {
                    seconds++;
                    console.log(`[${extensionName}] 计时器更新，当前值: ${seconds}s`);
                    
                    // 关键修正：通过提示框包含的基础文本定位元素（toastr默认会把文本放在.toast-message中）
                    const $toastElement = $(`.toast-message:contains("${baseText}")`).closest('.toast');
                    console.log(`[${extensionName}] 查找提示框元素（文本特征: ${baseText}），结果: ${$toastElement.length > 0 ? '找到' : '未找到'}`);
                    
                    if ($toastElement.length) {
                        const newText = `${baseText} ${seconds}s`;
                        $toastElement.find('.toast-message').text(newText);
                        console.log(`[${extensionName}] 提示框文本已更新: ${newText}`);
                    } else {
                        clearInterval(timer);
                        console.log(`[${extensionName}] 提示框已关闭，清除定时器`);
                    }
                }, 1000);

                // 处理每个匹配的媒体标签
                for (const match of matches) {
                    let originalPrompt = '';
                    let originalVideoParams = '';
                    let finalPrompt = '';

                    // 根据媒体类型处理不同的捕获组
                    if (mediaType === 'video') {
                        // 视频类型：match[1] 是 videoParams，match[2] 是 prompt
                        originalVideoParams = typeof match?.[1] === 'string' ? match[1] : '';
                        originalPrompt = typeof match?.[2] === 'string' ? match[2] : '';
                        alert(originalVideoParams)
                        alert(originalPrompt)
                        console.log(`[${extensionName}] 提取的视频参数: originalVideoParams="${originalVideoParams}", originalPrompt="${originalPrompt}"`);
                        
                        // 处理 videoParams：解析帧数、宽度、高度（如果有的话）
                        if (originalVideoParams && originalVideoParams.trim()) {
                            const params = originalVideoParams.split(',');
                            if (params.length === 3) {
                                const [frameCount, width, height] = params;
                                // 构建 setvar 字符串
                                const setvarString = `{{setvar::videoFrameCount::${frameCount}}}{{setvar::videoWidth::${width}}}{{setvar::videoHeight::${height}}}`;
                                // 合并 prompt：videoParams + originalPrompt
                                finalPrompt = setvarString + originalPrompt;
                                console.log(`[${extensionName}] 合并后的提示词: ${finalPrompt}`);
                            } else {
                                console.warn(`[${extensionName}] videoParams 格式错误，应为"帧数,宽度,高度": ${originalVideoParams}，将忽略videoParams`);
                                // 格式错误时，只使用原始prompt
                                finalPrompt = originalPrompt;
                            }
                        } else {
                            console.log(`[${extensionName}] 没有videoParams，只使用原始prompt`);
                            finalPrompt = originalPrompt;
                        }
                    } else {
                        // 图片类型：保持原有逻辑
                        originalPrompt = typeof match?.[1] === 'string' ? match[1] : '';
                        finalPrompt = originalPrompt;
                    }
                    
                    if (!finalPrompt.trim()) {
                        console.log(`[${extensionName}] 提示词为空，跳过`);
                        continue;
                    }
                    
                    console.log(`[${extensionName}] 生成媒体，提示词: ${finalPrompt.substring(0, 50)}...`);

                    // 调用sd命令生成媒体（使用finalPrompt）
                    const result = await SlashCommandParser.commands['sd'].callback(
                        {
                            quiet: 'true'
                        },
                        finalPrompt
                    );
                    
                    console.log(`[${extensionName}] 媒体生成结果:`, result);

                    if (typeof result === 'string' && result.trim().length > 0) {
                        // 处理替换逻辑
                        const originalTag = typeof match?.[0] === 'string' ? match[0] : '';
                        if (!originalTag) {
                            console.log(`[${extensionName}] 未找到原始标签，跳过`);
                            continue;
                        }
                        
                        // 获取样式
                        const style = extension_settings[extensionName].style || '';
                        
                        console.log(`[${extensionName}] 使用${mediaType}类型，样式: ${style}`);
                        
                        // 转义URL和原始prompt（不是finalPrompt）
                        const escapedUrl = escapeHtmlAttribute(result);
                        const escapedOriginalPrompt = originalPrompt;
                        
                        // 创建适当的媒体标签
                        let mediaTag;
                        if (mediaType === 'video') {
                            // 转义原始的videoParams值（如果有的话）
                            const escapedVideoParams = originalVideoParams ? escapeHtmlAttribute(originalVideoParams) : '';
                            mediaTag = `<video src="${escapedUrl}" ${originalVideoParams ? `videoParams="${escapedVideoParams}"` : ''} prompt="${escapedOriginalPrompt}" style="${style}" loop controls autoplay muted/>`;
                        } else {
                            // 图片标签保持不变
                            
                            mediaTag = `<img src="${escapedUrl}" prompt="${escapedOriginalPrompt}" style="${style}" onclick="window.open(this.src)" />`;
                     
                        }
                        
                        console.log(`[${extensionName}] 生成的媒体标签:`, mediaTag);
                        
                        // 替换消息中的标签
                        message.mes = message.mes.replace(originalTag, mediaTag);

                        // 更新消息显示
                        updateMessageBlock(context.chat.length - 1, message);
                        await eventSource.emit(event_types.MESSAGE_UPDATED, context.chat.length - 1);

                        // 保存聊天
                        await context.saveChat();
                        console.log(`[${extensionName}] 媒体替换后已保存聊天`);
                    }
                }

                clearInterval(timer);
                console.log(`[${extensionName}] 生成成功，清除定时器`);
                toastr.clear(toast);
                toastr.success(`成功生成 ${matches.length} ${mediaTypeText},一共耗时${seconds}s`);

            } catch (error) {
                // 出错时也需要清除计时器
                clearInterval(timer);
                toastr.error(`Media generation error: ${error}`);
                console.error(`[${extensionName}] 媒体生成错误:`, error);
            }
        }, 0); // 防阻塞UI渲染
    }
}
