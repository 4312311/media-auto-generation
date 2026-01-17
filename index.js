// 媒体自动生成插件主脚本 - V6.0 (回归稳定版)
// 核心逻辑回归最初版本 (High Performance)，仅增加变量互斥锁修复非流式 Bug。
// 修复：
// 1. 流式/非流式图片丢失问题 (通过强制兜底刷新解决)。
// 2. 变量覆盖问题 (通过 Mutex 锁解决)。
// 3. 找回"替换完成"的总结提示。

import { extension_settings, getContext } from '../../../extensions.js';
import {
    saveSettingsDebounced,
    eventSource,
    event_types,
    updateMessageBlock,
    substituteParams 
} from '../../../../script.js';
import { regexFromString } from '../../../utils.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';

const extensionName = 'media-auto-generation';
const extensionFolderPath = `/scripts/extensions/third-party/${extensionName}`;

// --- 全局状态 ---
let isStreamActive = false;
let streamInterval = null;
let updateDebounceTimer = null;

// 缓存与锁
const generatedCache = new Map();       // Hash -> HTML
const promptHistory = new Map();        // Hash -> Time
const processingHashes = new Set();     // Hash (正在运行)

// 【核心修复】：变量设置互斥锁
// 仅用于串行化 setvar 操作，不阻塞网络请求
let variableLock = Promise.resolve();

const PROMPT_COOLDOWN_MS = 180000;

const defaultSettings = {
    mediaType: 'disabled',
    imageRegex: '/<pic\\b(?![^>]*\\bsrc\\s*=)(?:(?:(?!\\bprompt\\b)[^>])*\\blight_intensity\\s*=\\s*"([^"]*)")?(?:(?!\\bprompt\\b)[^>])*\\bprompt\\s*=\\s*"([^"]*)"[^>]*>/gi',
    videoRegex: '/<video\\b(?:(?:(?!\\bprompt\\b)[^>])*\\bvideoParams\\s*=\\s*"([^"]*)")?(?:(?!\\bprompt\\b)[^>])*\\bprompt\\s*=\\s*"([^"]*)"[^>]*>/gi',
    style: 'width:auto;height:auto',
    streamGeneration: false,
};

// --- 基础工具 ---
function simpleHash(str) {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) hash = (hash * 33) ^ str.charCodeAt(i);
    return (hash >>> 0).toString(16);
}

function normalizePrompt(str) {
    return str ? str.trim().replace(/\s+/g, ' ').toLowerCase() : "";
}

function pruneOldPrompts() {
    const now = Date.now();
    for (const [hash, ts] of promptHistory.entries()) {
        if (now - ts > PROMPT_COOLDOWN_MS) {
            promptHistory.delete(hash);
            generatedCache.delete(hash);
        }
    }
}

function escapeHtmlAttribute(s) {
    if (typeof s !== 'string') return '';
    return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function extractPromptInfo(match, mediaType) {
    let rawExtraParams = match[1] || "";
    let rawPrompt = (match[2] || "").trim();

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
        if (rawExtraParams) {
            const arr = rawExtraParams.split(',').map(s => s.trim());
            macroString = `{{setvar::light_intensity::${arr[0]||0}}}{{setvar::sunshine_intensity::${arr[1]||0}}}`;
        }
    }
    return { rawPrompt, rawExtraParams, macroString };
}

function buildMediaTag(resultUrl, rawPrompt, rawParams, mediaType) {
    const style = extension_settings[extensionName].style || '';
    const escUrl = escapeHtmlAttribute(resultUrl);
    const escPrompt = escapeHtmlAttribute(rawPrompt);
    const escParams = escapeHtmlAttribute(rawParams);

    if (mediaType === 'video') {
        return `<video src="${escUrl}" ${escParams?`videoParams="${escParams}"`:''} prompt="${escPrompt}" style="${style}" loop controls autoplay muted/>`;
    } else {
        const light = escParams ? `light_intensity="${escParams}"` : 'light_intensity="0"';
        return `<img src="${escUrl}" ${light} prompt="${escPrompt}" style="${style}" onclick="window.open(this.src)" />`;
    }
}

// --- 设置部分 (保持不变) ---
async function loadSettings() {
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    if (Object.keys(extension_settings[extensionName]).length === 0) Object.assign(extension_settings[extensionName], defaultSettings);
    else for (const key in defaultSettings) if (extension_settings[extensionName][key] === undefined) extension_settings[extensionName][key] = defaultSettings[key];
}
async function createSettings(html) {
    if (!$('#media_auto_generation_container').length) $('#extensions_settings2').append('<div id="media_auto_generation_container" class="extension_container"></div>');
    $('#media_auto_generation_container').empty().append(html);
    const bind = (id, k) => $(id).on(k==='streamGeneration'?'change':'input change', function(){
        extension_settings[extensionName][k] = k==='streamGeneration'?$(this).prop('checked'):$(this).val();
        saveSettingsDebounced();
    });
    bind('#mediaType','mediaType'); bind('#image_regex','imageRegex'); bind('#video_regex','videoRegex');
    bind('#media_style','style'); bind('#stream_generation','streamGeneration');
    
    if ($('#mediaType').length) {
        $('#mediaType').val(extension_settings[extensionName].mediaType);
        $('#image_regex').val(extension_settings[extensionName].imageRegex);
        $('#video_regex').val(extension_settings[extensionName].videoRegex);
        $('#media_style').val(extension_settings[extensionName].style);
        $('#stream_generation').prop('checked', extension_settings[extensionName].streamGeneration ?? false);
    }
}
$(function(){
    (async function(){
        const html = await $.get(`${extensionFolderPath}/settings.html`);
        $('#extensionsMenu').append(`<div id="auto_generation" class="list-group-item flex-container flexGap5"><div class="fa-solid fa-film"></div><span data-i18n="Media Auto Generation">Media Auto Generation</span></div>`);
        $('#auto_generation').off('click').on('click', ()=>{ $('#extensions-settings-button .drawer-toggle').trigger('click'); setTimeout(()=>$('#media_auto_generation_container .inline-drawer-header').trigger('click'),500); });
        await loadSettings(); await createSettings(html);
    })();
});

// --- 核心逻辑 ---

/**
 * 刷新消息内容
 * @param {boolean} showToast 是否显示总结提示 (只在非流式或最终完成时显示)
 */
async function updateMessageContent(showToast = false) {
    if (!extension_settings[extensionName] || extension_settings[extensionName].mediaType === 'disabled') return;

    const context = getContext();
    const index = context.chat.length - 1;
    const msg = context.chat[index];
    if (!msg || msg.is_user || !msg.mes) return;

    const mediaType = extension_settings[extensionName].mediaType;
    const regexStr = mediaType === 'image' ? extension_settings[extensionName].imageRegex : extension_settings[extensionName].videoRegex;
    const regex = regexFromString(regexStr);

    let currentText = msg.mes;
    let modified = false;
    let replacedCount = 0;

    // 1. 替换所有已缓存的标签
    currentText = currentText.replace(regex, (match, ...args) => {
        // 构造 match 数组
        const groups = args.slice(0, -2);
        const matchArr = [match, ...groups];
        
        if (match.includes('src=') || match.includes('src =')) return match;
        
        const info = extractPromptInfo(matchArr, mediaType);
        if (!info) return match;

        const hash = simpleHash(normalizePrompt(info.rawPrompt));
        if (generatedCache.has(hash)) {
            modified = true;
            replacedCount++;
            return generatedCache.get(hash);
        }
        return match;
    });

    // 2. 提交更新
    if (modified) {
        msg.mes = currentText;
        updateMessageBlock(index, msg);
        
        // 防抖保存，防止高频 IO
        if (updateDebounceTimer) clearTimeout(updateDebounceTimer);
        updateDebounceTimer = setTimeout(async () => {
            await eventSource.emit(event_types.MESSAGE_UPDATED, index);
        }, 100);

        // 3. 提示
        if (showToast && replacedCount > 0) {
            toastr.success(`已替换 ${replacedCount} 个${mediaType === 'image' ? '图片' : '视频'}`);
        }
    }
}

/**
 * 触发任务 (并发执行，SetVar互斥)
 */
async function triggerGeneration(match, mediaType, index) {
    const info = extractPromptInfo(match, mediaType);
    if (!info) return;

    const hash = simpleHash(normalizePrompt(info.rawPrompt));
    
    // 检查缓存/运行中/冷却
    if (generatedCache.has(hash) || processingHashes.has(hash)) return;
    const now = Date.now();
    if (promptHistory.has(hash) && (now - promptHistory.get(hash) < PROMPT_COOLDOWN_MS)) return;

    processingHashes.add(hash);
    promptHistory.set(hash, now);

    // 异步执行，不阻塞主线程
    (async () => {
        let timer = null;
        let seconds = 0;
        let toast = null;
        const typeName = mediaType === 'image' ? '图片' : '视频';

        try {
            let finalPrompt = "";

            // --- 互斥锁区域 (解决非流式变量覆盖Bug) ---
            await (variableLock = variableLock.then(async () => {
                if (info.macroString) await substituteParams(info.macroString);
                finalPrompt = await substituteParams(info.rawPrompt);
            }).catch(e => console.error(e)));
            // --- 互斥锁结束 ---

            // 显示倒计时
            const baseText = `正在生成第 ${index + 1} 张${typeName}...`;
            toast = toastr.info(`${baseText} 0s`, '', { timeOut: 0, extendedTimeOut: 0 });
            timer = setInterval(() => {
                seconds++;
                if (toast && toast.find) toast.find('.toast-message').text(`${baseText} ${seconds}s`);
            }, 1000);

            // 调用接口
            const res = await SlashCommandParser.commands['sd'].callback({ quiet: 'true' }, finalPrompt);

            if (timer) clearInterval(timer);
            if (toast) toastr.clear(toast);

            if (res && res.trim().length > 0) {
                const tag = buildMediaTag(res, info.rawPrompt, info.rawExtraParams, mediaType);
                generatedCache.set(hash, tag);
                
                // 生成成功后，立即尝试刷新界面
                // 不管是流式还是非流式，生成好了就应该显示，这才是最直观的
                updateMessageContent(false); 
            }
        } catch (e) {
            console.error(e);
            if (timer) clearInterval(timer);
            if (toast) toastr.clear(toast);
            processingHashes.delete(hash);
            promptHistory.delete(hash); // 失败回滚
        } finally {
            // processingHashes.delete(hash); // 暂时保留，直到 MessageUpdated 再清? 或者不保留
            // 这里为了防止重复触发，建议生成成功后不立即删，等冷却过期。
            // 但如果为了容错，可以不删。这里保持 V1 逻辑：运行完就不管了，靠历史记录防重。
            processingHashes.delete(hash);
        }
    })();
}

/**
 * 扫描并触发所有任务
 */
function scanAndTriggerAll() {
    if (!extension_settings[extensionName] || extension_settings[extensionName].mediaType === 'disabled') return;
    
    const context = getContext();
    const msg = context.chat[context.chat.length - 1];
    if (!msg || msg.is_user || !msg.mes) return;

    const mediaType = extension_settings[extensionName].mediaType;
    const regexStr = mediaType === 'image' ? extension_settings[extensionName].imageRegex : extension_settings[extensionName].videoRegex;
    const matches = [...msg.mes.matchAll(regexFromString(regexStr))];

    matches.forEach((match, idx) => {
        if (match[0].includes('src=') || match[0].includes('src =')) return;
        triggerGeneration(match, mediaType, idx);
    });
}

// --- 事件监听 ---

eventSource.on(event_types.GENERATION_STARTED, () => {
    processingHashes.clear();
    if (!extension_settings[extensionName]?.streamGeneration) return;

    isStreamActive = true;
    if (streamInterval) clearInterval(streamInterval);
    
    streamInterval = setInterval(() => {
        if (!isStreamActive) { clearInterval(streamInterval); return; }
        scanAndTriggerAll();
        // 流式期间不强制刷 UI，完全依赖 triggerGeneration 内部的回调
        // 这样如果生成得快，流式中间也能看到图；如果慢，就等后面
    }, 500);
});

const onGenerationFinished = async () => {
    if (streamInterval) { clearInterval(streamInterval); streamInterval = null; }
    isStreamActive = false;
    
    pruneOldPrompts();
    // 最终全量刷新 + 提示
    await updateMessageContent(true);
};

eventSource.on(event_types.GENERATION_ENDED, onGenerationFinished);
eventSource.on(event_types.GENERATION_STOPPED, onGenerationFinished);

// 非流式/兜底
eventSource.on(event_types.MESSAGE_RECEIVED, async () => {
    onGenerationFinished(); // 确保流式定时器关了
    scanAndTriggerAll();    // 扫描所有任务
    // 这里不需要立即 updateMessageContent，因为 scanAndTriggerAll 里的异步任务完成后会自己调
});
