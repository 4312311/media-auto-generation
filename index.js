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
    mediaType: 'image', // 默认图片
    regex: '/<media[^>]*\\sprompt="([^"]*)"[^>]*?>/g',
    style: 'width:auto;height:auto', // 默认图片样式
};

// 从设置更新UI
function updateUI() {
    console.log(`[${extensionName}] 正在更新UI`);
    
    // 只在表单元素存在时更新它们
    if ($('#mediaType').length) {
        $('#mediaType').val(extension_settings[extensionName].mediaType);
        $('#media_regex').val(extension_settings[extensionName].regex);
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

    $('#media_regex').on('input', function () {
        console.log(`[${extensionName}] 正则表达式已更新`);
        extension_settings[extensionName].regex = $(this).val();
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
    
    // 确保设置对象存在
    if (!extension_settings[extensionName]) {
        console.log(`[${extensionName}] 未找到设置，终止处理`);
        return;
    }

    const context = getContext();
    const message = context.chat[context.chat.length - 1];

    // 检查是否是AI消息
    if (!message || message.is_user) {
        console.log(`[${extensionName}] 消息来自用户，跳过处理`);
        return;
    }

    // 确保regex属性存在
    if (!extension_settings[extensionName].regex) {
        console.error(`[${extensionName}] 正则表达式设置未正确初始化`);
        return;
    }

    // 使用正则表达式搜索
    const mediaTagRegex = regexFromString(
        extension_settings[extensionName].regex
    );
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
            try {
                console.log(`[${extensionName}] 开始生成${matches.length}个媒体项`);
                toastr.info(`Generating ${matches.length} media items...`);

                // 处理每个匹配的媒体标签
                for (const match of matches) {
                    const prompt = typeof match?.[1] === 'string' ? match[1] : '';
                    if (!prompt.trim()) {
                        console.log(`[${extensionName}] 提示词为空，跳过`);
                        continue;
                    }
                    
                    console.log(`[${extensionName}] 生成媒体，提示词: ${prompt.substring(0, 50)}...`);

                    // 调用sd命令生成媒体
                    const result = await SlashCommandParser.commands['sd'].callback(
                        {
                            quiet: 'true'
                        },
                        prompt
                    );
                    
                    console.log(`[${extensionName}] 媒体生成结果:`, result);

                    if (typeof result === 'string' && result.trim().length > 0) {
                        // 处理替换逻辑
                        const originalTag = typeof match?.[0] === 'string' ? match[0] : '';
                        if (!originalTag) {
                            console.log(`[${extensionName}] 未找到原始标签，跳过`);
                            continue;
                        }
                        
                        // 获取媒体类型和样式
                        const mediaType = extension_settings[extensionName].mediaType || 'image';
                        const style = extension_settings[extensionName].style || '';
                        
                        console.log(`[${extensionName}] 使用${mediaType}类型，样式: ${style}`);
                        
                        // 转义URL和prompt
                        const escapedUrl = escapeHtmlAttribute(result);
                        const escapedPrompt = escapeHtmlAttribute(prompt);
                        
                        // 创建适当的媒体标签
                        let mediaTag;
                        if (mediaType === 'video') {
                            mediaTag = `<video src="${escapedUrl}" prompt="${escapedPrompt}" style="${style}">`;
                        } else {
                            mediaTag = `<img src="${escapedUrl}" prompt="${escapedPrompt}" style="${style}">`;
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
                
                toastr.success(`${matches.length} media items generated successfully`);
                console.log(`[${extensionName}] 媒体生成完成`);
            } catch (error) {
                toastr.error(`Media generation error: ${error}`);
                console.error(`[${extensionName}] 媒体生成错误:`, error);
            }
        }, 0); // 防阻塞UI渲染
    }
}
