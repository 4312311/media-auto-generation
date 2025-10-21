// 导入核心模块
import { extension_settings } from '../../../extensions.js';
import {
    saveSettingsDebounced,
    eventSource,
    event_types,
    updateMessageBlock,
    appendMediaToMessage
} from '../../../../script.js';
import { regexFromString } from '../../../utils.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';

// 插件常量定义
const extensionName = 'st-media-generation';
const extensionFolderPath = `/scripts/extensions/third-party/${extensionName}`;
const INSERT_TYPE = { REPLACE: 'replace', NEW_MESSAGE: 'new' };

// 默认设置
const defaultSettings = {
    mediaType: 'image',
    promptInjection: {
        regex: '/<media[^>]*\\sprompt="([^"]*)"[^>]*?>/g'
    }
};

// 从设置更新UI
function updateUIFromSettings() {
    const settings = extension_settings[extensionName];
    $('#media_type').val(settings.mediaType);
    $('#media_regex').val(settings.promptInjection.regex);
}

// 创建设置面板
async function createSettings(settingsHtml) {
    if (!$('#media_generation_container').length) {
        $('#extensions_settings2').append(
            '<div id="media_generation_container" class="extension_container"></div>'
        );
    }
    $('#media_generation_container').empty().append(settingsHtml);

    // 绑定设置变更事件
    $('#media_type').on('change', function() {
        extension_settings[extensionName].mediaType = $(this).val();
        saveSettingsDebounced();
    });

    $('#media_regex').on('input', function() {
        extension_settings[extensionName].promptInjection.regex = $(this).val();
        saveSettingsDebounced();
    });

    updateUIFromSettings();
}

// 设置按钮点击事件
function onExtensionButtonClick() {
    const extensionsDrawer = $('#extensions-settings-button .drawer-toggle');
    if ($('#rm_extensions_block').hasClass('closedDrawer')) {
        extensionsDrawer.trigger('click');
    }

    setTimeout(() => {
        const container = $('#media_generation_container');
        if (container.length) {
            $('#rm_extensions_block').animate({
                scrollTop: container.offset().top - $('#rm_extensions_block').offset().top + $('#rm_extensions_block').scrollTop()
            }, 500);

            const drawerContent = container.find('.inline-drawer-content');
            const drawerHeader = container.find('.inline-drawer-header');
            if (drawerContent.is(':hidden') && drawerHeader.length) {
                drawerHeader.trigger('click');
            }
        }
    }, 500);
}

// 初始化设置
async function loadSettings() {
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    if (!extension_settings[extensionName].promptInjection) {
        extension_settings[extensionName].promptInjection = defaultSettings.promptInjection;
    }
    Object.assign(extension_settings[extensionName], 
        defaultSettings, 
        extension_settings[extensionName]
    );
    updateUIFromSettings();
}

// 媒体生成核心逻辑
async function generateMedia(prompt, insertType) {
    // @ts-ignore
    const result = await SlashCommandParser.commands[
        'sd'
    ].callback(
        {
            quiet: insertType === INSERT_TYPE.NEW_MESSAGE ? 'false' : 'true',
        },
        prompt,
    );
    return result.url;
}

// 处理消息替换
async function processMessage(messageText, messageId) {
    const settings = extension_settings[extensionName];
    const regex = regexFromString(settings.promptInjection.regex);
    
    if (!regex) return messageText;

    let processedText = messageText;
    const matches = messageText.matchAll(regex);

    for (const match of matches) {
        if (match.length >= 2) {
            const fullMatch = match[0];
            const prompt = match[1];
            
            try {
                const url = await generateMedia(prompt, INSERT_TYPE.REPLACE);
                const replacement = settings.mediaType === 'image'
                    ? `<img src="${url}" prompt="${escapeHtmlAttribute(prompt)}">`
                    : `<video src="${url}" prompt="${escapeHtmlAttribute(prompt)}" controls>`;
                
                processedText = processedText.replace(fullMatch, replacement);
            } catch (error) {
                console.error('媒体生成失败:', error);
            }
        }
    }

    return processedText;
}

// HTML属性转义
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

// 监听消息事件
function setupMessageListener() {
    eventSource.on(event_types.MESSAGE_RECEIVED, async (data) => {
        if (data.message.role !== 'assistant') return;
        
        const processedText = await processMessage(data.message.text, data.message.id);
        if (processedText !== data.message.text) {
            data.message.text = processedText;
            updateMessageBlock($(`#message_${data.message.id}`), data.message);
        }
    });
}

// 初始化插件
$(function () {
    (async function () {
        // 加载设置HTML
        const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);

        // 添加扩展菜单
        $('#extensionsMenu').append(`
            <div id="media_generation_menu" class="list-group-item flex-container flexGap5">
                <div class="fa-solid fa-film"></div>
                <span data-i18n="Media Generation">媒体自动生成</span>
            </div>
        `);

        $('#media_generation_menu').off('click').on('click', onExtensionButtonClick);

        await loadSettings();
        await createSettings(settingsHtml);

        // 确保设置面板打开时UI正确更新
        $('#extensions-settings-button').on('click', function () {
            setTimeout(() => {
                updateUIFromSettings();
            }, 200);
        });

        setupMessageListener();
        console.log('Media Generation Plugin initialized');
    })();
});
