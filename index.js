/* ============================================================
   预填充兼容修复 (PrefillCompatFix) — 主逻辑模块（index.js）
   ============================================================ */

/* 【区块索引】（按文件从上到下的顺序）
   1. 可调参数与常量     模型名单、占位内容、安装时机
   2. 模型清单设置       用户清单、设置弹窗、更新提示、入口注入与清理
   3. 状态变量           挂钩状态与最近一次判断结果
   4. 日志工具           统一日志前缀与级别
   5. 基础工具           请求对象、URL、Header、模型名等纯函数
   6. 模型名提取         按明确优先级收集候选并返回最终来源
   7. 消息数组选择       在 messages / contents 之间做单目标选择
   8. 请求体分析与修改   正文描述、统一修改计划、追加 user
   9. Fetch 请求拦截     主窗口与同源 iframe 共用包装逻辑
   10. XHR 请求拦截       open/send 包装与同步补全判定
   11. Hook 安装         主窗口、同源 iframe、动态 iframe（fetch + XHR）
   12. 调试接口          测试与排查用的 window.__PrefillCompatFix
   13. 初始化            等待 ST 就绪后安装
   ============================================================ */

/* ── 可调参数与常量 ───────────────────── */

const PLUGIN_KEY = 'PrefillCompatFix';
const PLUGIN_DISPLAY_NAME = '预填充兼容修复';
const BUILTIN_UPDATE_TOAST_TITLE = `${PLUGIN_DISPLAY_NAME}・内置清单更新`;
const ENABLED = true;                  /* 内部安全开关：当前版本固定启用，不提供用户总开关 */
const DEBUG_LOGS = false;              /* 是否输出详细调试日志 */
const DEFAULT_PLACEHOLDER_TEXT = '\u200B'; /* 默认追加消息内容 */
const APP_READY_FALLBACK_MS = 1200;    /* APP_READY 已错过时的单次兜底安装延时(ms) */
const JSON_BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);

/* 默认保护名单：实际模型名包含任一配置项即命中，不区分大小写。
   设置弹窗会在内置清单基础上合并自定义与手动移除记录，得到最终生效清单 */
const MODEL_PATTERNS = [
    /* Google Gemini */
    'gemini-3.5-flash-lite',
    'gemini-3.6-flash',
    'gemini-3.7-flash',
    'gemini-3.8-flash',
    'gemini-4-argon',
    'gemini-4-carbon',
    'gemini-4-hydrogen',

    /* Anthropic Claude：4.6 及后续型号 */
    'claude-opus-4-6',
    'claude-opus-4-7',
    'claude-opus-4-8',
    'claude-opus-5',
    'claude-opus-5-5',

    'claude-sonnet-4-6',
    'claude-sonnet-5',
    'claude-sonnet-5-5',

    'claude-haiku-5-5',

    'claude-fable-5',
    'claude-fable-5-1',
    'claude-fable-5-2',
];

/* ── 模型清单设置 ─────────────────────── */

const MODEL_LIST_INPUT_ID = 'pcf-model-list-input';
const MODEL_LIST_MAX_LINES = 100;      /* 清单行数上限，防止整段粘贴灌爆设置文件 */
const MODEL_LIST_LINK_ID = 'pcf-model-list-link';
const MODEL_LIST_LINK_PUSH_ID = 'pcf-model-list-push';
const HELP_BUTTON_ID = 'pcf-help-button';
const CUSTOM_CONTENT_TOGGLE_ID = 'pcf-custom-content-toggle';
const CUSTOM_CONTENT_INPUT_ID = 'pcf-custom-content-input';
const BUILTIN_UPDATE_PREVIEW_LIMIT = 5; /* 更新提示中单组型号最多展示数量 */
/* 不可见字符：控制字符 + 常见零宽/双向格式字符；空白类字符另行归一为半角空格 */
const INVISIBLE_CHAR_RE = /[\u0000-\u0008\u000E-\u001F\u007F-\u009F\u00AD\u034F\u061C\u17B4-\u17B5\u180B-\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\uFFF9-\uFFFB]/g;
/* 需要当成空格处理的空白（换行与全角空格在切分前/后单独处理） */
const SPACE_LIKE_RE = /[\t\f\v\u00A0\u1680\u2000-\u200A\u202F\u205F]/g;
/* 本次页面加载是否已检查并处理内置清单更新 */
let builtinUpdateChecked = false;
/* 使用说明弹窗是否已打开，避免连续点击叠加多个说明页 */
let usageHelpOpen = false;
/* 使用说明：可直接调整小标题、正文和列表内容 */
const USAGE_HELP_SECTIONS = [
    {
        heading: '工作原理',
        paragraphs: [
            '修复部分模型因不支持预填充（请求以非 user 角色结尾）导致的「error 400: Requests ending with a model turn are not supported」报错。',
            '当请求的模型命中生效清单，且末条消息不为 user 时，插件会在末尾静默追加一条用户消息（默认为零宽空格），使请求正常发送。',
        ],
    },
    {
        heading: '设置说明',
        items: [
            '生效模型清单：每行填写一个接口实际的「模型 ID」，保存即生效。采用不区分大小写的包含匹配，请勿填写过短的通用词（如 gemini），以免误伤正常模型。',
            '名单更新同步：插件更新内置名单时会自动同步并提醒；手动删除过的内置型号不会自动恢复。',
            '自定义补充消息：仅建议在默认的零宽空格被其他插件或上游过滤时勾选（可尝试填写「继续」、「Continue」或标点符号）。自定义内容会实际发送给模型，可能轻微影响回复。',
        ],
    },
    {
        heading: '注意事项与排查',
        items: [
            '适用范围：仅解决「末尾角色非 user（预填充）」引发的 400 报错，不涵盖上下文超限、参数错误、空消息等其他原因导致的 400 错误。',
            '兼容性：支持 ST 原生及常见第三方插件请求，未覆盖采用特殊加密、后端代理打包或跨域隔离的请求链路。',
            '未生效排查：若启用后仍报相同错误，请依次检查：① 模型 ID 是否拼写准确；② 尝试开启「自定义补充消息」绕过空消息过滤。',
        ],
    },
];

/* 从 ST 设置中读取自定义与手动移除记录；结构异常时按空处理 */
function getModelListStored() {
    const context = getStContext();
    if (!context || !context.extensionSettings) {
        return { custom: [], removed: [] };
    }

    const stored = context.extensionSettings[PLUGIN_KEY];
    if (!isPlainObject(stored)) {
        return { custom: [], removed: [] };
    }

    const pick = (value) => Array.isArray(value)
        ? value.filter((x) => typeof x === 'string' && x.trim() !== '')
        : [];

    return { custom: pick(stored.custom), removed: pick(stored.removed) };
}

/* 读取自定义补充消息设置；结构异常或读取失败时返回空状态 */
function getCustomContentStored() {
    try {
        const context = getStContext();
        const stored = context && context.extensionSettings
            ? context.extensionSettings[PLUGIN_KEY]
            : null;
        if (!isPlainObject(stored)) {
            return { enabled: false, content: '' };
        }
        return {
            enabled: stored.customContentEnabled === true,
            content: typeof stored.customContent === 'string' ? stored.customContent : '',
        };
    } catch (error) {
        logWarn('读取自定义补充消息内容失败，使用默认值', error);
        return { enabled: false, content: '' };
    }
}

/* 计算本次追加内容：自定义非空且已启用时原样使用，否则回退默认值 */
function getEffectivePlaceholderText() {
    const custom = getCustomContentStored();
    return custom.enabled && custom.content.length > 0
        ? custom.content
        : DEFAULT_PLACEHOLDER_TEXT;
}

/* 生效清单 = 内置清单 − 删除记录 + 自定义；按型号串不区分大小写去重 */
function getEffectiveModelPatterns() {
    const { custom, removed } = getModelListStored();
    const removedKeys = new Set(removed.map(normalizeModelName).filter((x) => x !== ''));
    const seen = new Set();
    const result = [];

    for (const pattern of MODEL_PATTERNS) {
        const key = normalizeModelName(pattern);
        if (key === '' || seen.has(key) || removedKeys.has(key)) continue;
        seen.add(key);
        result.push(pattern);
    }

    for (const pattern of custom) {
        const key = normalizeModelName(pattern);
        if (key === '' || seen.has(key)) continue;
        seen.add(key);
        result.push(pattern);
    }

    return result;
}

/* 生成设置弹窗使用的文本：把当前生效清单按一行一条展示 */
function getModelListText() {
    return getEffectiveModelPatterns().join('\n');
}

/* 保存模型清单；传入自定义补充消息参数时同时保存，未传入则保留原值 */
function saveModelListSettings(lines, customContentEnabled, customContent) {
    const builtinKeys = new Set(MODEL_PATTERNS.map(normalizeModelName));
    const custom = [];
    const removed = [];

    for (const line of lines) {
        const key = normalizeModelName(line);
        if (key === '') continue;
        if (builtinKeys.has(key)) continue;
        custom.push(line);
    }

    for (const pattern of MODEL_PATTERNS) {
        const key = normalizeModelName(pattern);
        if (!key) continue;
        if (lines.some((line) => normalizeModelName(line) === key)) continue;
        removed.push(pattern);
    }

    const context = getStContext();
    if (!context || !context.extensionSettings) {
        return false;
    }

    const stored = context.extensionSettings[PLUGIN_KEY];
    /* 合并写入，避免清除内置清单快照等元数据 */
    const next = {
        ...(isPlainObject(stored) ? stored : {}),
        custom,
        removed,
    };
    if (typeof customContentEnabled === 'boolean') {
        next.customContentEnabled = customContentEnabled;
    }
    if (typeof customContent === 'string') {
        next.customContent = customContent;
    }
    context.extensionSettings[PLUGIN_KEY] = next;
    if (typeof context.saveSettingsDebounced === 'function') {
        context.saveSettingsDebounced();
    }
    return true;
}

/* 读取上次记录的内置清单快照；从未记录过时返回 null */
function getBuiltinSnapshot(context) {
    const stored = context && context.extensionSettings
        ? context.extensionSettings[PLUGIN_KEY]
        : null;
    if (!isPlainObject(stored) || !Array.isArray(stored.builtinSnapshot)) {
        return null;
    }

    return stored.builtinSnapshot.filter((x) => typeof x === 'string' && x.trim() !== '');
}

/* 保存当前内置清单快照，并保留用户自定义与删除记录 */
function saveBuiltinSnapshot(context) {
    const stored = context.extensionSettings[PLUGIN_KEY];
    context.extensionSettings[PLUGIN_KEY] = {
        ...(isPlainObject(stored) ? stored : {}),
        builtinSnapshot: MODEL_PATTERNS.slice(),
    };
    if (typeof context.saveSettingsDebounced === 'function') {
        context.saveSettingsDebounced();
    }
}

/* 按型号集合计算内置清单差异；顺序或大小写变化不算变化 */
function getBuiltinListDiff(previous, current) {
    const beforeKeys = new Set(previous.map(normalizeModelName).filter((x) => x !== ''));
    const afterKeys = new Set(current.map(normalizeModelName).filter((x) => x !== ''));

    return {
        added: current.filter((x) => {
            const key = normalizeModelName(x);
            return key !== '' && !beforeKeys.has(key);
        }),
        removed: previous.filter((x) => {
            const key = normalizeModelName(x);
            return key !== '' && !afterKeys.has(key);
        }),
    };
}

/* 截取提示中的型号列表：最多展示 5 个，超出时直接追加三个点 */
function formatNoticePatternList(patterns, decorate = (x) => x) {
    const shown = patterns
        .slice(0, BUILTIN_UPDATE_PREVIEW_LIMIT)
        .map((x) => decorate(x));
    return `${shown.join('、')}${patterns.length > BUILTIN_UPDATE_PREVIEW_LIMIT ? '...' : ''}`;
}

/* 生成两段式更新提示：新增在上、移除在下；用户状态说明跟随对应段落 */
function formatBuiltinListUpdateMessage(previous, current, custom, userRemoved) {
    const { added, removed } = getBuiltinListDiff(previous, current);
    if (added.length === 0 && removed.length === 0) return '';

    const customKeys = new Set(custom.map(normalizeModelName).filter((x) => x !== ''));
    const removedKeys = new Set(userRemoved.map(normalizeModelName).filter((x) => x !== ''));
    const addedCustom = added.filter((x) => customKeys.has(normalizeModelName(x)));
    const addedManuallyRemoved = added.filter((x) => {
        const key = normalizeModelName(x);
        return removedKeys.has(key) && !customKeys.has(key);
    });
    const removedManuallyAdded = removed.filter((x) => customKeys.has(normalizeModelName(x)));
    const removedManuallyRemoved = removed.filter((x) => (
        removedKeys.has(normalizeModelName(x)) && !customKeys.has(normalizeModelName(x))
    ));

    const blocks = [];
    if (added.length > 0) {
        const notes = [];
        if (addedCustom.length > 0) {
            notes.push(`${formatNoticePatternList(addedCustom)} 此前已在自定义清单中`);
        }
        if (addedManuallyRemoved.length > 0) {
            notes.push(`${formatNoticePatternList(addedManuallyRemoved)} 为手动移除项，继续关闭`);
        }
        const noteText = notes.length > 0 ? `；其中 ${notes.join('；')}` : '';
        blocks.push(`新增 ${added.length} 项：${formatNoticePatternList(added)}${noteText}。`);
    }

    if (removed.length > 0) {
        const notes = [];
        if (removedManuallyAdded.length > 0) {
            notes.push(`${formatNoticePatternList(removedManuallyAdded)} 为手动添加项，继续保留`);
        }
        if (removedManuallyRemoved.length > 0) {
            notes.push(`${formatNoticePatternList(removedManuallyRemoved)} 此前已由自定义清单移除`);
        }
        const noteText = notes.length > 0 ? `；其中 ${notes.join('；')}` : '';
        blocks.push(`移除 ${removed.length} 项：${formatNoticePatternList(removed)}${noteText}。`);
    }

    return blocks.join('<br>');
}

/* 页面加载后检查一次内置清单变化；首次安装只记录快照，不提示 */
function checkBuiltinListUpdateOnce() {
    if (builtinUpdateChecked) return;

    try {
        const context = getStContext();
        if (!context || !context.extensionSettings) return;

        const previous = getBuiltinSnapshot(context);
        if (previous === null) {
            builtinUpdateChecked = true;
            saveBuiltinSnapshot(context);
            return;
        }

        const diff = getBuiltinListDiff(previous, MODEL_PATTERNS);
        if (diff.added.length === 0 && diff.removed.length === 0) {
            builtinUpdateChecked = true;
            if (JSON.stringify(previous) !== JSON.stringify(MODEL_PATTERNS)) {
                saveBuiltinSnapshot(context);
            }
            return;
        }

        const toastr = window.toastr;
        if (!toastr || typeof toastr.info !== 'function') return;

        const { custom, removed } = getModelListStored();
        const message = formatBuiltinListUpdateMessage(previous, MODEL_PATTERNS, custom, removed);
        if (!message) return;

        builtinUpdateChecked = true;
        toastr.info(message, BUILTIN_UPDATE_TOAST_TITLE, {
            timeOut: 12000,
            extendedTimeOut: 5000,
            closeButton: true,
            progressBar: true,
            /* ST 默认转义 HTML；此处仅含内置型号，关闭转义以渲染分段换行 */
            escapeHtml: false,
        });
        saveBuiltinSnapshot(context);
    } catch (error) {
        logWarn('检查内置清单更新提示失败', error);
    }
}

/* ST 清理钩子：只删除本插件的设置，不影响其他扩展保存的数据 */
function cleanExtensionData() {
    const context = getStContext();
    if (!context || !context.extensionSettings) {
        return;
    }

    delete context.extensionSettings[PLUGIN_KEY];
}

export { cleanExtensionData };

/* 清洗用户输入：返回 { lines, fixes, issues }；issues 非空时需用户确认 */
function normalizeModelListInput(text) {
    const raw = typeof text === 'string' ? text : '';
    /* 换行统一为 \n；其他 Unicode 空白在逐行清洗时转为半角空格 */
    const normalized = raw
        .replace(/\r\n?/g, '\n')
        .replace(/[\u0085\u2028\u2029]/g, '\n');
    const rawLines = normalized.split('\n');

    /* 按实际发生的清洗动作分类统计；同一行可计入多个类别（N 表示涉及条目数） */
    let blankLines = 0;
    let trimLines = 0;
    let collapseLines = 0;
    let invisibleLines = 0;
    let fullWidthSpaceLines = 0;
    const lines = [];

    for (const rawLine of rawLines) {
        const hadFullWidthSpace = rawLine.includes('\u3000');
        if (hadFullWidthSpace) fullWidthSpaceLines += 1;
        const normalizedLine = rawLine.replace(/\u3000/g, ' ').replace(SPACE_LIKE_RE, ' ');
        const stripped = normalizedLine.replace(INVISIBLE_CHAR_RE, '');
        const hadInvisible = stripped !== normalizedLine;
        if (hadInvisible) invisibleLines += 1;

        const line = stripped.trim().replace(/ {2,}/g, ' ');
        if (line === '') {
            blankLines += 1;
            continue;
        }
        if (stripped !== stripped.trim()) trimLines += 1;
        if (/ {2,}/.test(stripped.trim())) collapseLines += 1;
        lines.push(line);
    }

    const result = [];
    const seen = new Set();
    const issues = [];
    const fixes = [];
    let duplicates = 0;
    let separators = 0;
    let specialChars = 0;

    for (const line of lines) {
        if (/[,;:，；：、]/.test(line)) separators += 1;
        if (/[^\u0000-\u007F]/.test(line)) specialChars += 1;

        const key = line.toLowerCase();
        if (seen.has(key)) {
            duplicates += 1;
            continue;
        }
        seen.add(key);
        result.push(line);
    }

    if (fullWidthSpaceLines > 0) fixes.push(`全角空格转为半角（${fullWidthSpaceLines}）`);
    if (invisibleLines > 0) fixes.push(`清除不可见字符（${invisibleLines}）`);
    if (blankLines > 0) fixes.push(`移除空行（${blankLines}）`);
    if (trimLines > 0) fixes.push(`移除首尾空格（${trimLines}）`);
    if (collapseLines > 0) fixes.push(`合并行内连续空格（${collapseLines}）`);
    if (duplicates > 0) fixes.push(`移除重复项（${duplicates}）`);
    if (specialChars > 0) issues.push(`存在全角字符或其他特殊字符（${specialChars}）`);

    /* 首尾空格已清除，清洗后仍含空格的条目才算内部空格 */
    const spaced = result.filter((line) => /\s/.test(line)).length;
    if (spaced > 0) issues.push(`包含行内空格，可能无法正确匹配（${spaced}）`);
    if (separators > 0) issues.push(`存在逗号/分号等分隔符，请确认模型名是否需要拆分（${separators}）`);

    return { lines: result, fixes, issues, tooMany: result.length > MODEL_LIST_MAX_LINES };
}

/* 让弹窗列表及其项目文字左对齐，避免 ST 默认居中时圆点与文字错位。
   只处理列表本身，标题和说明文字仍保持弹窗默认对齐 */
function applyPopupListAlign(list) {
    list.style.textAlign = 'left';
    list.querySelectorAll('li').forEach((li) => {
        li.style.textAlign = 'left';
    });
}

/* 往弹窗正文追加一组列表项；只对齐列表本身，说明文字仍保持弹窗默认居中 */
function appendPopupList(parent, items) {
    const list = document.createElement('ul');
    for (const item of items) {
        const li = document.createElement('li');
        li.textContent = item;
        list.appendChild(li);
    }
    parent.appendChild(list);
    applyPopupListAlign(list);
}

/* 按「小标题 + 正文 / 列表」构造使用说明的一个分段 */
function appendUsageHelpSection(parent, section) {
    const block = document.createElement('section');
    block.className = 'flex-container flexFlowColumn';
    block.style.gap = '0.4em';

    const heading = document.createElement('h4');
    heading.className = 'margin0';
    heading.textContent = section.heading;
    block.appendChild(heading);

    for (const text of section.paragraphs || []) {
        const paragraph = document.createElement('p');
        paragraph.className = 'margin0';
        paragraph.style.lineHeight = '1.55';
        paragraph.textContent = text;
        block.appendChild(paragraph);
    }

    if (Array.isArray(section.items) && section.items.length > 0) {
        const list = document.createElement('ul');
        list.style.margin = '0';
        list.style.paddingLeft = '1.25em';
        list.style.lineHeight = '1.55';
        for (const text of section.items) {
            const item = document.createElement('li');
            item.textContent = text;
            item.style.marginBottom = '0.3em';
            list.appendChild(item);
        }
        block.appendChild(list);
    }

    parent.appendChild(block);
}

/* 构造使用说明正文；只使用 ST 原生排版类，滚动交给弹窗内容区 */
function buildUsageHelpDialogContent() {
    const content = document.createElement('div');
    content.className = 'flex-container flexFlowColumn';
    content.style.gap = '1em';
    content.style.paddingBottom = '0.25em';

    const title = document.createElement('h3');
    title.className = 'margin0 textAlignCenter';
    title.textContent = `使用说明`;
    content.appendChild(title);

    for (const section of USAGE_HELP_SECTIONS) {
        appendUsageHelpSection(content, section);
    }

    return content;
}

/* 打开使用说明弹窗；正文过长时由 ST 原生竖向滚动区域显示进度条 */
async function openUsageHelpDialog() {
    if (usageHelpOpen) return;

    const context = getStContext();
    if (!context || !context.POPUP_TYPE || !context.POPUP_RESULT) {
        logWarn('无法打开使用说明：ST 弹窗组件不可用');
        return;
    }

    const PopupClass = context.Popup
        || (window.SillyTavern && window.SillyTavern.libs && window.SillyTavern.libs.Popup);
    if (typeof PopupClass !== 'function') {
        logWarn('无法打开使用说明：ST Popup 类不可用');
        return;
    }

    usageHelpOpen = true;
    try {
        const popup = new PopupClass(
            buildUsageHelpDialogContent(),
            context.POPUP_TYPE.TEXT,
            '',
            {
                wide: true,
                /* 桌面按内容自然收缩；窄屏保留大弹窗，避免说明区域过于拥挤 */
                large: window.innerWidth <= 768,
                leftAlign: true,
                allowVerticalScrolling: true,
                okButton: false,
                cancelButton: false,
                defaultResult: context.POPUP_RESULT.NEGATIVE,
                customButtons: [
                    {
                        text: '关闭',
                        result: context.POPUP_RESULT.NEGATIVE,
                    },
                ],
            },
        );
        await popup.show();
    } finally {
        usageHelpOpen = false;
    }
}

/* 构造弹窗正文：模型清单与自定义补充消息设置 */
function buildModelListDialogContent(initialText, customContentState) {
    const content = document.createElement('div');
    content.className = 'flex-container flexFlowColumn height100p';

    const titleRow = document.createElement('div');
    titleRow.className = 'flex-container';
    titleRow.style.alignItems = 'center';
    titleRow.style.justifyContent = 'center';
    titleRow.style.gap = '0.4em';

    const title = document.createElement('h3');
    title.className = 'margin0 textAlignCenter';
    title.textContent = PLUGIN_DISPLAY_NAME;

    const helpButton = document.createElement('button');
    helpButton.type = 'button';
    helpButton.id = HELP_BUTTON_ID;
    helpButton.className = 'fa-solid fa-circle-question note-link-span';
    helpButton.title = '查看使用说明';
    helpButton.setAttribute('aria-label', '查看使用说明');
    helpButton.style.border = '0';
    helpButton.style.padding = '0';
    helpButton.style.margin = '0';
    helpButton.style.background = 'transparent';
    helpButton.style.lineHeight = '1';
    helpButton.style.fontSize = '0.95em';
    helpButton.style.transform = 'translateY(0.8px)';
    helpButton.style.cursor = 'pointer';
    helpButton.style.flex = '0 0 auto';
    helpButton.addEventListener('click', () => {
        void openUsageHelpDialog();
    });
    titleRow.append(title, helpButton);

    const area = document.createElement('div');
    area.className = 'flex1 flex-container flexFlowColumn';

    const hint = document.createElement('h4');
    hint.className = 'margin0';
    hint.textContent = '生效模型清单（每行一个，保存生效）';

    const textarea = document.createElement('textarea');
    textarea.id = MODEL_LIST_INPUT_ID;
    textarea.className = 'text_pole';
    textarea.placeholder = '例如：\ngemini-3.7-flash\ngemini-3.8-flash\ngemini-4-argon';
    textarea.spellcheck = false;
    textarea.value = initialText;
    /* 保留较高的默认高度和下方空间，并允许用户拖拽调整 */
    textarea.style.height = '42vh';
    textarea.style.minHeight = '8em';
    textarea.style.maxHeight = '75vh';

    area.appendChild(hint);
    area.appendChild(textarea);

    const customSection = document.createElement('div');
    customSection.className = 'flex-container flexFlowColumn';
    customSection.style.marginTop = '0.75em';

    const customHeading = document.createElement('h4');
    customHeading.className = 'margin0';
    customHeading.style.display = 'flex';
    customHeading.style.justifyContent = 'center';
    customHeading.style.alignItems = 'center';
    const customLabel = document.createElement('label');
    customLabel.style.display = 'inline-flex';
    customLabel.style.alignItems = 'center';
    customLabel.style.gap = '0.35em';
    customLabel.style.cursor = 'pointer';
    const customToggle = document.createElement('input');
    customToggle.type = 'checkbox';
    customToggle.id = CUSTOM_CONTENT_TOGGLE_ID;
    customToggle.checked = !!(customContentState && customContentState.enabled);
    customToggle.style.margin = '0';
    customToggle.style.flex = '0 0 auto';
    customToggle.style.transform = 'translateY(0.3px)';
    customLabel.append(
        customToggle,
        '自定义补充消息内容（勾选启用）',
    );
    customHeading.appendChild(customLabel);

    const customInput = document.createElement('textarea');
    customInput.id = CUSTOM_CONTENT_INPUT_ID;
    customInput.className = 'text_pole';
    customInput.rows = window.innerWidth <= 768 ? 4 : 3;
    customInput.spellcheck = false;
    customInput.placeholder = '补充末尾 user 消息时，使用此处内容替换默认零宽空格。内容会实际发给 AI，请注意语义影响。\n例如：Continue、继续';
    customInput.value = customContentState && typeof customContentState.content === 'string'
        ? customContentState.content
        : '';

    const updateCustomInputState = () => {
        const enabled = customToggle.checked;
        customInput.disabled = !enabled;
        if (enabled) {
            customInput.style.removeProperty('background-color');
        } else {
            customInput.style.setProperty(
                'background-color',
                'color-mix(in srgb, var(--SmartThemeBlurTintColor) 78%, var(--SmartThemeBodyColor) 22%)',
                'important',
            );
        }
        /* 主题默认的 brightness(0.5) 会把自适应灰色再次压暗，禁用态改用背景色表达 */
        customInput.style.filter = enabled ? '' : 'none';
    };
    customToggle.addEventListener('change', () => {
        updateCustomInputState();
    });
    updateCustomInputState();

    customSection.appendChild(customHeading);
    customSection.appendChild(customInput);
    area.appendChild(customSection);

    content.appendChild(titleRow);
    content.appendChild(area);
    return { content, textarea, customToggle, customInput };
}

/* 校验清单，并在超限、空清单或存在问题等情况下提示用户；返回是否允许保存 */
async function confirmModelListIssues(text) {
    const context = getStContext();
    if (!context) return false;

    const info = normalizeModelListInput(text);

    /* 超过行数上限：直接拒绝保存 */
    if (info.tooMany) {
        await context.callGenericPopup(
            '行数超出上限，请删减后重试。',
            context.POPUP_TYPE.CONFIRM,
            '',
            { okButton: '确定', cancelButton: false },
        );
        return false;
    }

    /* 空清单等同于关闭全部模型保护，保存前单独确认 */
    if (info.lines.length === 0) {
        const emptyNotice = document.createElement('div');
        emptyNotice.append('模型清单为空，将');
        const emptyStrong = document.createElement('strong');
        emptyStrong.textContent = '不再对任何模型进行自动修复';
        emptyNotice.append(emptyStrong);
        emptyNotice.append('。确定保存吗？');
        const confirmed = await context.callGenericPopup(
            emptyNotice,
            context.POPUP_TYPE.CONFIRM,
            '',
            { okButton: '确定', cancelButton: '取消' },
        );
        return confirmed === context.POPUP_RESULT.AFFIRMATIVE;
    }

    const hasFixes = info.fixes.length > 0;
    const hasIssues = info.issues.length > 0;

    /* 同时存在自动修正与待确认问题时，合并为一次确认 */
    if (hasFixes && hasIssues) {
        const wrap = document.createElement('div');
        const fixTitle = document.createElement('h4');
        fixTitle.className = 'margin0';
        fixTitle.textContent = '已自动修正格式：';
        wrap.appendChild(fixTitle);
        appendPopupList(wrap, info.fixes);

        /* 间隔块避免列表下边距折叠，使两个提示区域保持分开 */
        const sectionGap = document.createElement('div');
        sectionGap.dataset.pcfSectionGap = '';
        sectionGap.style.height = '0.75em';
        wrap.appendChild(sectionGap);

        const issueTitle = document.createElement('h4');
        issueTitle.className = 'margin0';
        issueTitle.textContent = '修正后仍检测到以下问题，请确认是否保存：';
        wrap.appendChild(issueTitle);
        appendPopupList(wrap, info.issues);

        const confirmed = await context.callGenericPopup(
            wrap,
            context.POPUP_TYPE.CONFIRM,
            '',
            { okButton: '确定', cancelButton: '取消' },
        );
        return confirmed === context.POPUP_RESULT.AFFIRMATIVE;
    }

    /* 只有自动修正时展示信息框，无需再次确认 */
    if (hasFixes) {
        const fixedWrap = document.createElement('div');
        const fixedTitle = document.createElement('h4');
        fixedTitle.className = 'margin0';
        fixedTitle.textContent = '已自动修正格式并保存：';
        fixedWrap.appendChild(fixedTitle);
        appendPopupList(fixedWrap, info.fixes);
        await context.callGenericPopup(fixedWrap, context.POPUP_TYPE.CONFIRM, '', { okButton: '确定', cancelButton: false });
        return true;
    }

    /* 无待确认内容时直接允许保存 */
    if (!hasIssues) {
        return true;
    }

    /* 使用 DOM 节点展示动态文本，避免模型名被当成 HTML */
    const wrap = document.createElement('div');
    const ask = document.createElement('h4');
    ask.className = 'margin0';
    ask.textContent = '检测到以下问题，请确认是否保存：';
    wrap.appendChild(ask);
    appendPopupList(wrap, info.issues);

    const confirmed = await context.callGenericPopup(
        wrap,
        context.POPUP_TYPE.CONFIRM,
        '',
        { okButton: '确定', cancelButton: '取消' },
    );
    return confirmed === context.POPUP_RESULT.AFFIRMATIVE;
}

/* 打开设置弹窗，并处理保存、取消与恢复默认 */
async function openModelListDialog() {
    const context = getStContext();
    if (!context || typeof context.callGenericPopup !== 'function' || !context.POPUP_TYPE) {
        logWarn('无法打开模型清单设置：ST 弹窗组件不可用');
        return;
    }

    const PopupClass = context.Popup
        || (window.SillyTavern && window.SillyTavern.libs && window.SillyTavern.libs.Popup);
    if (typeof PopupClass !== 'function') {
        logWarn('无法打开模型清单设置：ST Popup 类不可用');
        return;
    }

    const popupType = context.POPUP_TYPE;
    const resultTypes = context.POPUP_RESULT;
    const parts = buildModelListDialogContent(getModelListText(), getCustomContentStored());
    let savePending = false;

    /* 不启用 large 固定高度：由内容决定初始尺寸，拖大后再使用原生竖向滚动 */
    const popup = new PopupClass(parts.content, popupType.TEXT, '', {
        wide: true,
        allowVerticalScrolling: true,
        okButton: false,
        cancelButton: false,
        customButtons: [
            { text: '保存', classes: ['popup-button-ok'], action: () => { savePending = true; popup.completeAffirmative(); } },
            { text: '取消', classes: ['popup-button-cancel'], result: resultTypes.NEGATIVE, appendAtEnd: true },
            { text: '恢复默认', action: () => { void handleRestore(); }, appendAtEnd: true },
        ],
        onClosing: async () => {
            /* 保存前校验；不通过时保持弹窗并保留输入 */
            if (savePending) {
                const ok = await confirmModelListIssues(parts.textarea.value);
                if (!ok) {
                    savePending = false;
                    return false;
                }
            }
            return true;
        },
    });

    const handleRestore = async () => {
        const ctx = getStContext() || context;
        const confirmed = await ctx.callGenericPopup(
            '将清空自定义条目，并恢复内置清单。确定恢复吗？',
            popupType.CONFIRM,
            '',
            { okButton: '确定', cancelButton: '取消' },
        );
        if (confirmed !== resultTypes.AFFIRMATIVE) return;

        /* 原地填入内置清单，仍需用户点「保存」才写回设置 */
        parts.textarea.value = MODEL_PATTERNS.join('\n');
        parts.textarea.focus();
    };

    const result = await popup.show();
    if (result === resultTypes.AFFIRMATIVE) {
        const info = normalizeModelListInput(parts.textarea.value);
        const saved = saveModelListSettings(
            info.lines,
            parts.customToggle.checked,
            parts.customInput.value,
        );
        if (!saved) {
            logWarn('保存模型清单失败：ST 设置接口不可用');
        }
    }
}

/* 在 API 面板「查看密钥」右侧注入设置入口。
   仅插入本插件元素，并用 0 宽撑杆维持该行原有的两端布局 */
function installModelListLink() {
    const existing = document.getElementById(MODEL_LIST_LINK_ID);
    if (existing && document.body.contains(existing)) return true;

    const viewSecrets = document.getElementById('viewSecrets');
    if (!viewSecrets || !viewSecrets.parentElement) return false;

    const link = document.createElement('a');
    link.id = MODEL_LIST_LINK_ID;
    link.href = 'javascript:void(0);';
    link.textContent = PLUGIN_DISPLAY_NAME;
    link.addEventListener('click', () => {
        openModelListDialog();
    });

    /* 撑杆用自动外边距继续把「查看密钥」顶在右侧 */
    if (!document.getElementById(MODEL_LIST_LINK_PUSH_ID)) {
        const push = document.createElement('span');
        push.id = MODEL_LIST_LINK_PUSH_ID;
        push.style.marginLeft = 'auto';
        viewSecrets.parentElement.insertBefore(push, viewSecrets);
    }

    viewSecrets.parentElement.insertBefore(link, viewSecrets.nextSibling);
    return true;
}

/* ── 状态变量 ─────────────────────────── */

/* 窗口 → 已安装的 fetch 包装 */
const hookedFetchHooks = new WeakMap();
/* XHR 实例 → open 参数（send 时读取，重复 open 会覆盖） */
const xhrOpenMeta = new WeakMap();
/* realm → 安装时的 XHR 原型方法，用于检测重复安装或原型被替换 */
const hookedXhrProtos = new WeakMap();
/* 已经计入统计的窗口 */
const hookedWindows = new WeakSet();
/* 已经绑定 load 监听的 iframe */
const iframeLoadListenersAttached = new WeakSet();

/* 主窗口 hook（fetch + XHR）是否已安装 */
let mainHookInstalled = false;
/* iframe hook（fetch + XHR）扫描器是否已安装 */
let iframeHooksInstalled = false;
/* 已安装 hook 的 iframe 窗口数量（用于调试） */
let iframeHookCount = 0;
/* 最近一次请求的简要判断结果 */
let lastDecision = null;
/* 最近一次请求正文描述摘要（不持有正文或大对象引用） */
let lastBodyDescriptor = null;
/* 请求正文处理计数，供测试验证没有重复读取、解析或分析 */
const requestPipelineStats = {
    requestReads: 0,
    jsonParses: 0,
    analyses: 0,
    modifications: 0,
};
/* 启动成功提示是否已输出过 */
let startupLogged = false;

/* ── 日志工具 ─────────────────────────── */

function logDebug(message, detail) {
    if (!DEBUG_LOGS) return;
    if (detail === undefined) {
        console.debug(`[${PLUGIN_KEY}] ${message}`);
    } else {
        console.debug(`[${PLUGIN_KEY}] ${message}`, detail);
    }
}

function logInfo(message, detail) {
    if (!DEBUG_LOGS) return;
    if (detail === undefined) {
        console.info(`[${PLUGIN_KEY}] ${message}`);
    } else {
        console.info(`[${PLUGIN_KEY}] ${message}`, detail);
    }
}

/* 启动成功提示：无论 DEBUG_LOGS 开关都只输出一次 */
function logStartupOnce() {
    if (startupLogged) return;
    startupLogged = true;
    console.info(`[${PLUGIN_KEY}] 预填充兼容修复已加载`);
}

function logWarn(message, detail) {
    if (detail === undefined) {
        console.warn(`[${PLUGIN_KEY}] ${message}`);
    } else {
        console.warn(`[${PLUGIN_KEY}] ${message}`, detail);
    }
}

function logError(message, error) {
    if (error === undefined) {
        console.error(`[${PLUGIN_KEY}] ${message}`);
    } else {
        console.error(`[${PLUGIN_KEY}] ${message}`, error);
    }
}

/* ── 基础工具 ─────────────────────────── */

/* 判断是否为普通对象（不含数组与 null） */
function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

/* 判断是否为 Request 类似对象：跨 realm 时 instanceof 不可靠，使用鸭子类型 */
function isRequestLike(input) {
    return !!input
        && typeof input === 'object'
        && typeof input.clone === 'function'
        && typeof input.text === 'function';
}

/* 获取 fetch 输入对应的 URL 字符串 */
function getFetchRequestUrl(input) {
    if (typeof input === 'string') return input;
    if (input && typeof input.url === 'string') return input.url;
    try {
        if (input instanceof URL) return input.toString();
    } catch (error) {
        /* 跨 realm 的 URL 对象可能无法直接 instanceof，忽略 */
    }
    return '';
}

/* 获取请求 URL 的 URL 对象；失败时返回 null */
function getRequestUrlObject(requestUrl) {
    if (!requestUrl) return null;
    try {
        return new URL(requestUrl, window.location.href);
    } catch (error) {
        return null;
    }
}

function getRequestPathname(requestUrl) {
    const urlObject = getRequestUrlObject(requestUrl);
    return urlObject ? urlObject.pathname.toLowerCase() : '';
}

/* 安全读取 Headers 中的字段值 */
function getHeaderValue(headers, name) {
    if (headers === undefined || headers === null) return null;
    try {
        return new Headers(headers).get(name);
    } catch (error) {
        return null;
    }
}

function getEffectiveMethod(input, init) {
    if (init && typeof init.method === 'string' && init.method) {
        return init.method.toUpperCase();
    }
    if (isRequestLike(input) && typeof input.method === 'string' && input.method) {
        return input.method.toUpperCase();
    }
    return 'GET';
}

function getEffectiveContentType(input, init) {
    if (init && init.headers !== undefined && init.headers !== null) {
        return getHeaderValue(init.headers, 'content-type');
    }
    if (isRequestLike(input)) {
        return getHeaderValue(input.headers, 'content-type');
    }
    return null;
}

/* 判断 Content-Type 是否可按 JSON 文本处理 */
function isJsonContentType(contentType) {
    if (!contentType) return true;
    const lower = String(contentType).toLowerCase();
    return lower.includes('application/json') || lower.includes('+json');
}

/* 返回不支持按 JSON/普通对象处理的正文原因；null 表示可以继续判断。
   这里只做类型识别，不读取、不枚举、不转换二进制或表单正文。 */
function getUnsupportedBodyReason(value) {
    if (value === '') return 'empty-body';
    if (Array.isArray(value)) return 'array-body';
    if (typeof value !== 'object' || value === null) return 'non-object-body';

    let tag = '';
    try {
        tag = Object.prototype.toString.call(value);
    } catch (error) {
        return 'body-classification-failed';
    }
    if (tag === '[object Blob]' || tag === '[object File]') return 'blob-body';
    if (tag === '[object FormData]') return 'form-data-body';
    if (tag === '[object URLSearchParams]') return 'url-search-params-body';
    if (tag === '[object ArrayBuffer]') return 'array-buffer-body';
    if (tag === '[object DataView]') return 'data-view-body';
    if (tag === '[object ReadableStream]') return 'readable-stream-body';
    try {
        if (ArrayBuffer.isView(value)) return 'typed-array-body';
    } catch (error) {
        return 'body-classification-failed';
    }
    if (tag !== '[object Object]') return 'unsupported-object-body';
    return null;
}

/* 构造请求正文描述；valuePromise 只用于尚未读取的 Request 正文。 */
function makeBodyDescriptor(state, origin, value, options = {}) {
    return {
        state,
        origin,
        value,
        valuePromise: options.valuePromise || null,
        hasRawText: options.hasRawText === true,
        unsupportedReason: options.unsupportedReason || null,
    };
}

/* 生成只含分类字段的正文摘要，避免调试接口长期持有请求正文。 */
function summarizeBodyDescriptor(descriptor) {
    if (!descriptor) return null;
    return {
        state: descriptor.state,
        origin: descriptor.origin,
        hasRawText: !!descriptor.hasRawText,
        unsupportedReason: descriptor.unsupportedReason || '',
    };
}

function safeDecodeURIComponent(value) {
    if (typeof value !== 'string') return '';
    try {
        return decodeURIComponent(value);
    } catch (error) {
        return value;
    }
}

function normalizeModelName(value) {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function normalizeRole(value) {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/* 返回第一个命中的配置项；未命中返回空字符串 */
function findMatchedModelPattern(modelName) {
    const normalizedModel = normalizeModelName(modelName);
    if (!normalizedModel) return '';

    for (const pattern of getEffectiveModelPatterns()) {
        const normalizedPattern = normalizeModelName(pattern);
        if (!normalizedPattern) continue;
        if (normalizedModel.includes(normalizedPattern)) return normalizedPattern;
    }

    return '';
}

/* ── 模型名提取 ───────────────────────── */

/* 收集请求体与 URL 中出现的模型候选，保持优先级顺序 */
function collectModelCandidates(body, requestUrl) {
    const candidates = [];

    function addCandidate(value, source) {
        if (typeof value !== 'string') return;
        const trimmed = value.trim();
        if (!trimmed) return;
        candidates.push({ value: trimmed, source });
    }

    addCandidate(body.model, 'body.model');
    addCandidate(body.generationConfig && body.generationConfig.model, 'body.generationConfig.model');
    addCandidate(body.model_name, 'body.model_name');
    addCandidate(body.modelName, 'body.modelName');
    addCandidate(body.engine, 'body.engine');

    const urlObject = getRequestUrlObject(requestUrl);
    if (urlObject) {
        const pathMatch = urlObject.pathname.match(/\/models\/([^/:?#]+)/i);
        if (pathMatch && pathMatch[1]) {
            addCandidate(safeDecodeURIComponent(pathMatch[1]), 'url.path.models');
        }
        addCandidate(urlObject.searchParams.get('model'), 'url.query.model');
    }

    return candidates;
}

/* 获取最终采用的模型名、来源与全部候选 */
function getModelInfo(body, requestUrl) {
    const candidates = collectModelCandidates(body, requestUrl);
    const primary = candidates.length > 0 ? candidates[0] : null;
    const uniqueValues = new Set(candidates.map(item => normalizeModelName(item.value)));

    if (uniqueValues.size > 1) {
        logWarn('检测到多个不同的模型候选，按最高优先级字段处理', candidates);
    }

    const model = primary ? primary.value : '';
    const modelSource = primary ? primary.source : '';
    const matchedPattern = findMatchedModelPattern(model);

    return {
        model,
        modelSource,
        candidates,
        matched: !!matchedPattern,
        matchedPattern,
    };
}

/* ── 消息数组选择 ─────────────────────── */

/* 判断是否为非空数组 */
function hasNonEmptyArray(value) {
    return Array.isArray(value) && value.length > 0;
}

/* 选择本次请求实际应修改的消息数组 */
function selectTargetArray(body, requestUrl) {
    const hasMessages = hasNonEmptyArray(body.messages);
    const hasContents = hasNonEmptyArray(body.contents);

    if (hasMessages && !hasContents) {
        return { target: 'messages', reason: '' };
    }
    if (hasContents && !hasMessages) {
        return { target: 'contents', reason: '' };
    }
    if (!hasMessages && !hasContents) {
        return { target: null, reason: '请求体中没有可用的 messages 或 contents 数组' };
    }

    const pathname = getRequestPathname(requestUrl);
    const urlHintsGemini = pathname.includes('generatecontent') || pathname.includes('streamgeneratecontent');
    const urlHintsMessages = pathname.includes('chat/completions')
        || pathname.includes('chat-completions')
        || typeof body.chat_completion_source === 'string';

    if (urlHintsGemini && !urlHintsMessages) {
        return { target: 'contents', reason: '' };
    }
    if (urlHintsMessages && !urlHintsGemini) {
        return { target: 'messages', reason: '' };
    }

    return { target: null, reason: 'messages 与 contents 同时存在，无法安全判断实际使用的数组' };
}

/* ── 请求体分析与修改 ─────────────────── */

/* 分析已解析的 JSON 请求体，只做判断，不修改；纯检查可关闭计数。 */
function analyzeParsedBody(body, requestUrl, trackStats = true) {
    if (trackStats) requestPipelineStats.analyses++;
    const modelInfo = getModelInfo(body, requestUrl);
    if (!modelInfo.matched) {
        return {
            ...modelInfo,
            decision: 'not-target-model',
            reason: '模型未命中保护名单',
            target: null,
            lastRole: '',
            changed: false,
        };
    }

    const targetInfo = selectTargetArray(body, requestUrl);
    if (!targetInfo.target) {
        return {
            ...modelInfo,
            decision: targetInfo.reason.includes('无法安全判断') ? 'ambiguous-payload' : 'unsupported-body',
            reason: targetInfo.reason,
            target: null,
            lastRole: '',
            changed: false,
        };
    }

    const messages = body[targetInfo.target];
    const lastMessage = messages[messages.length - 1];
    if (!isPlainObject(lastMessage) || typeof lastMessage.role !== 'string') {
        return {
            ...modelInfo,
            decision: 'unsupported-body',
            reason: '目标数组末条不是带字符串 role 的普通对象',
            target: targetInfo.target,
            lastRole: '',
            changed: false,
        };
    }

    const lastRole = normalizeRole(lastMessage.role);
    if (lastRole === 'user') {
        return {
            ...modelInfo,
            decision: 'already-user',
            reason: '末条已经是 user',
            target: targetInfo.target,
            lastRole,
            changed: false,
        };
    }

    return {
        ...modelInfo,
        decision: 'needs-fix',
        reason: '命中目标模型且末条不是 user',
        target: targetInfo.target,
        lastRole,
        changed: false,
    };
}

/* 返回追加 user 消息后的新请求体，不修改传入对象 */
function buildFixedBody(body, target) {
    const placeholderText = getEffectivePlaceholderText();
    if (target === 'messages') {
        return {
            ...body,
            messages: [
                ...body.messages,
                { role: 'user', content: placeholderText },
            ],
        };
    }

    return {
        ...body,
        contents: [
            ...body.contents,
            { role: 'user', parts: [{ text: placeholderText }] },
        ],
    };
}

/* 读取本次 fetch 实际生效的正文来源；这里只分类，不读取 Request 内容。 */
function readFetchBodySource(input, init) {
    /* 读取本身属于执行异常；保留外层 modification-failed 回退语义。 */
    const body = init ? init.body : undefined;

    if (body !== undefined && body !== null) {
        if (typeof body === 'string') {
            if (body.length === 0) {
                return makeBodyDescriptor('unsupported', 'init-string', body, {
                    unsupportedReason: 'empty-body',
                });
            }
            return makeBodyDescriptor('text', 'init-string', body, { hasRawText: true });
        }
        const unsupportedReason = getUnsupportedBodyReason(body);
        if (unsupportedReason) {
            return makeBodyDescriptor('unsupported', 'init-body', body, { unsupportedReason });
        }
        return makeBodyDescriptor('structured-object', 'init-object', body);
    }

    if (!isRequestLike(input)) {
        return makeBodyDescriptor('none', 'none', null);
    }

    let valuePromise;
    try {
        const clonedRequest = input.clone();
        valuePromise = clonedRequest.text()
            .then((text) => {
                requestPipelineStats.requestReads++;
                return typeof text === 'string' ? text : null;
            })
            .catch(() => null);
    } catch (error) {
        valuePromise = Promise.resolve(null);
    }
    return makeBodyDescriptor('text', 'request-text', null, { valuePromise });
}

/* 将正文描述转换为可分析的普通对象；Request 文本最多读取一次。 */
async function materializeFetchBody(descriptor) {
    if (!descriptor || descriptor.state === 'none') {
        return { ok: false, reason: '请求没有可用正文' };
    }
    if (descriptor.state === 'unsupported') {
        return { ok: false, reason: `正文类型不支持：${descriptor.unsupportedReason || 'unknown'}` };
    }
    if (descriptor.state === 'structured-object') {
        return { ok: true, body: descriptor.value, rawText: null };
    }

    let rawText = descriptor.value;
    if (typeof rawText !== 'string' && descriptor.valuePromise) {
        rawText = await descriptor.valuePromise;
    }
    if (typeof rawText !== 'string') {
        return { ok: false, reason: 'Request body 无法 clone 或读取' };
    }
    if (rawText.length === 0) {
        return { ok: false, reason: '正文类型不支持：empty-body' };
    }

    let body;
    requestPipelineStats.jsonParses++;
    try {
        body = JSON.parse(rawText);
    } catch (error) {
        return { ok: false, reason: '请求体不是合法 JSON' };
    }
    if (!isPlainObject(body)) {
        return { ok: false, reason: '请求体 JSON 顶层不是普通对象' };
    }
    return { ok: true, body, rawText };
}

/* 生成正文不支持时的统一计划。 */
function makeUnsupportedPlan(requestUrl, reason, descriptor = null, options = {}) {
    const summary = summarizeBodyDescriptor(descriptor);
    return {
        changed: false,
        decision: options.decision || 'unsupported-body',
        reason,
        url: requestUrl,
        body: null,
        bodyState: summary ? summary.state : '',
        bodyOrigin: summary ? summary.origin : '',
        unsupportedReason: summary ? summary.unsupportedReason : '',
        errorStage: options.errorStage || '',
        errorMessage: options.errorMessage || '',
    };
}

/* 分析已解析正文并产出唯一修改计划；文本正文同时预生成替换字符串。 */
function planParsedBodyModification(body, requestUrl, options = {}) {
    const trackStats = options.trackStats !== false;
    const analysis = analyzeParsedBody(body, requestUrl, trackStats);
    const plan = {
        ...analysis,
        changed: false,
        url: requestUrl,
        body,
        rawText: options.rawText || null,
        bodyState: options.bodyState || '',
        bodyOrigin: options.bodyOrigin || '',
        replacementBody: null,
        fixedBodyText: null,
    };
    if (analysis.decision !== 'needs-fix') return plan;

    const fixedBody = buildFixedBody(body, analysis.target);
    let replacementBody = fixedBody;
    let fixedBodyText = null;
    if (options.bodyState === 'text') {
        fixedBodyText = JSON.stringify(fixedBody);
        replacementBody = fixedBodyText;
    }
    if (trackStats) requestPipelineStats.modifications++;
    return {
        ...plan,
        changed: true,
        decision: 'fixed',
        body: fixedBody,
        replacementBody,
        fixedBodyText,
    };
}

/* 用修改后的正文构造新的 fetch init，只覆盖 body。 */
function buildModifiedInit(init, bodyValue) {
    if (init && typeof init === 'object') {
        return { ...init, body: bodyValue };
    }
    return { body: bodyValue };
}

/* 分析并构造修改后的请求参数；任何无法安全完成的情况都返回 changed:false */
async function buildModifiedFetchArgs(input, init) {
    lastBodyDescriptor = null;
    const requestUrl = getFetchRequestUrl(input);
    const method = getEffectiveMethod(input, init);

    if (!JSON_BODY_METHODS.has(method)) {
        return makeUnsupportedPlan(requestUrl, `method ${method} 不是 JSON 写请求`);
    }

    const contentType = getEffectiveContentType(input, init);
    if (!isJsonContentType(contentType)) {
        return makeUnsupportedPlan(requestUrl, `Content-Type ${contentType} 不是 JSON`);
    }

    const descriptor = readFetchBodySource(input, init);
    lastBodyDescriptor = summarizeBodyDescriptor(descriptor);
    if (descriptor.state === 'none' || descriptor.state === 'unsupported') {
        return makeUnsupportedPlan(
            requestUrl,
            descriptor.state === 'none'
                ? '输入不是 Request 且没有可用正文'
                : `正文类型不支持：${descriptor.unsupportedReason || 'unknown'}`,
            descriptor,
        );
    }

    const bodyRead = await materializeFetchBody(descriptor);
    if (!bodyRead.ok) {
        return makeUnsupportedPlan(requestUrl, bodyRead.reason, descriptor);
    }

    const plan = planParsedBodyModification(bodyRead.body, requestUrl, {
        rawText: bodyRead.rawText,
        bodyState: descriptor.state,
        bodyOrigin: descriptor.origin,
    });
    if (plan.changed) {
        plan.modifiedInit = buildModifiedInit(init, plan.replacementBody);
    }
    return plan;
}

/* 供调试接口使用的纯检查函数，不发送请求 */
function inspectRequestBody(bodyOrText, requestUrl) {
    let body;

    if (typeof bodyOrText === 'string') {
        try {
            body = JSON.parse(bodyOrText);
        } catch (error) {
            return {
                changed: false,
                decision: 'unsupported-body',
                reason: '请求体不是合法 JSON',
                url: requestUrl || '',
                body: null,
            };
        }
    } else if (isPlainObject(bodyOrText)) {
        try {
            body = JSON.parse(JSON.stringify(bodyOrText));
        } catch (error) {
            return {
                changed: false,
                decision: 'unsupported-body',
                reason: '请求体无法复制',
                url: requestUrl || '',
                body: null,
            };
        }
    } else {
        return {
            changed: false,
            decision: 'unsupported-body',
            reason: '请求体不是对象或 JSON 字符串',
            url: requestUrl || '',
            body: null,
        };
    }

    if (!isPlainObject(body)) {
        return {
            changed: false,
            decision: 'unsupported-body',
            reason: '请求体 JSON 顶层不是普通对象',
            url: requestUrl || '',
            body,
        };
    }

    return planParsedBodyModification(body, requestUrl || '', {
        bodyState: typeof bodyOrText === 'string' ? 'text' : 'structured-object',
        bodyOrigin: typeof bodyOrText === 'string' ? 'inspect-string' : 'inspect-object',
        trackStats: false,
    });
}

/* 生成可安全保存和打印的简要判断结果 */
function summarizeDecision(plan) {
    return {
        timestamp: Date.now(),
        url: plan.url || '',
        decision: plan.decision || 'unsupported-body',
        reason: plan.reason || '',
        model: plan.model || '',
        modelSource: plan.modelSource || '',
        matchedPattern: plan.matchedPattern || '',
        candidates: plan.candidates || [],
        matched: !!plan.matched,
        target: plan.target || null,
        lastRole: plan.lastRole || '',
        changed: !!plan.changed,
        bodyState: plan.bodyState || '',
        bodyOrigin: plan.bodyOrigin || '',
        unsupportedReason: plan.unsupportedReason || '',
        errorStage: plan.errorStage || '',
        error: plan.errorMessage || '',
    };
}

/* 记录并打印最近一次判断结果 */
function recordDecision(plan) {
    const summary = summarizeDecision(plan);
    lastDecision = summary;

    if (summary.decision === 'fixed') {
        logInfo('已补齐末尾 user 消息', summary);
        return;
    }
    if (summary.decision === 'modification-failed') {
        logError('修改流程失败，按原请求发送', summary);
        return;
    }
    if (summary.decision === 'ambiguous-payload') {
        logWarn('请求体存在歧义，未修改', summary);
        return;
    }
    logDebug('未修改请求', summary);
}

/* ── Fetch 请求拦截 ───────────────────── */

/* 构造一个 fetch 包装；主窗口与同源 iframe 共用同一套逻辑 */
function createFetchHook(realmWindow, getOriginalFetch) {
    /* 调用原 fetch 期间置位：避免包装被自己再次拦截而递归 */
    let invokingOriginal = false;

    return async function hookedFetch(input, init) {
        const originalFetch = getOriginalFetch();

        if (!ENABLED) {
            return originalFetch.apply(realmWindow, [input, init]);
        }

        let method = 'GET';
        try {
            method = getEffectiveMethod(input, init);
        } catch (error) {
            return originalFetch.apply(realmWindow, [input, init]);
        }

        if (!JSON_BODY_METHODS.has(method)) {
            return originalFetch.apply(realmWindow, [input, init]);
        }

        if (invokingOriginal) {
            return originalFetch.apply(realmWindow, [input, init]);
        }

        let plan;
        try {
            plan = await buildModifiedFetchArgs(input, init);
        } catch (error) {
            plan = {
                changed: false,
                decision: 'modification-failed',
                reason: '插件修改阶段发生异常',
                url: getFetchRequestUrl(input),
                errorStage: 'modify',
                errorMessage: error && error.message ? error.message : String(error),
            };
        }

        recordDecision(plan);

        if (!plan.changed) {
            return originalFetch.apply(realmWindow, [input, init]);
        }

        invokingOriginal = true;
        try {
            return originalFetch.apply(realmWindow, [input, plan.modifiedInit]);
        } catch (error) {
            logError('修改后的 fetch 同步失败，回退原请求', error);
            return originalFetch.apply(realmWindow, [input, init]);
        } finally {
            invokingOriginal = false;
        }
    };
}

/* ── XHR 请求拦截 ─────────────────────── */

/* 按 realm 自身的地址把 XHR URL 解析为绝对地址 */
function resolveRealmUrl(realmWindow, url) {
    const raw = (typeof url === 'string') ? url : (url != null ? String(url) : '');
    if (!raw) return '';
    try {
        const base = (realmWindow && realmWindow.location) ? realmWindow.location.href : undefined;
        return new URL(raw, base).toString();
    } catch (error) {
        return raw;
    }
}

/* 对 XHR 正文做同步分类；不读取或枚举二进制、表单与流内容。 */
function readXhrBodySource(body) {
    if (body === undefined || body === null) {
        return makeBodyDescriptor('none', 'xhr-none', null);
    }
    if (typeof body === 'string') {
        if (body.length === 0) {
            return makeBodyDescriptor('unsupported', 'xhr-text', body, {
                unsupportedReason: 'empty-body',
            });
        }
        return makeBodyDescriptor('text', 'xhr-text', body, { hasRawText: true });
    }
    const unsupportedReason = getUnsupportedBodyReason(body);
    if (unsupportedReason) {
        return makeBodyDescriptor('unsupported', 'xhr-body', body, { unsupportedReason });
    }
    return makeBodyDescriptor('structured-object', 'xhr-object', body);
}

/* 同步构造 XHR 请求体的修改方案；发送方法是同步的，不能复用异步 fetch 流程。
   判断条件与 fetch 一致，无法安全修改时返回 changed:false。 */
function planXhrBodyModification(requestUrl, method, bodyValue) {
    lastBodyDescriptor = null;
    if (!JSON_BODY_METHODS.has(method)) {
        return makeUnsupportedPlan(requestUrl, `method ${method} 不是 JSON 写请求`);
    }

    const descriptor = readXhrBodySource(bodyValue);
    lastBodyDescriptor = summarizeBodyDescriptor(descriptor);
    if (descriptor.state === 'none' || descriptor.state === 'unsupported') {
        return makeUnsupportedPlan(
            requestUrl,
            descriptor.state === 'none'
                ? '请求没有可用正文'
                : `正文类型不支持：${descriptor.unsupportedReason || 'unknown'}`,
            descriptor,
        );
    }

    let body;
    if (descriptor.state === 'text') {
        requestPipelineStats.jsonParses++;
        try {
            body = JSON.parse(descriptor.value);
        } catch (error) {
            return makeUnsupportedPlan(requestUrl, '请求体不是合法 JSON', descriptor);
        }
        if (!isPlainObject(body)) {
            return makeUnsupportedPlan(requestUrl, '请求体 JSON 顶层不是普通对象', descriptor);
        }
    } else {
        body = descriptor.value;
    }

    return planParsedBodyModification(body, requestUrl, {
        rawText: descriptor.state === 'text' ? descriptor.value : null,
        bodyState: descriptor.state,
        bodyOrigin: descriptor.origin,
    });
}

/* 给单个 realm 安装 XHR 包装：open 记录请求信息，send 同步判断并按需替换 body。
   同一 realm 只安装一次；原型被替换后允许重新包装，保护逻辑异常时放行原请求 */
function installRealmXhrHook(realmWindow) {
    if (!realmWindow) return false;

    let proto = null;
    try {
        const ctor = realmWindow.XMLHttpRequest;
        proto = ctor && ctor.prototype;
    } catch (error) {
        return false;
    }
    if (!proto || typeof proto.open !== 'function' || typeof proto.send !== 'function') return false;

    const installed = hookedXhrProtos.get(realmWindow);
    if (installed && proto.open === installed.open && proto.send === installed.send) return true;

    const originalOpen = proto.open;
    const originalSend = proto.send;

    const hookedOpen = function hookedXhrOpen(method, url) {
        try {
            xhrOpenMeta.set(this, {
                method: typeof method === 'string' ? method.toUpperCase() : 'GET',
                url: resolveRealmUrl(realmWindow, url),
            });
        } catch (error) {
            /* 捕获失败不影响原 open 调用 */
        }
        return originalOpen.apply(this, arguments);
    };

    const hookedSend = function hookedXhrSend(body) {
        if (!ENABLED) return originalSend.apply(this, arguments);

        /* 修改后的请求正文；未修改时保留原参数直接发送 */
        let replacementBody = null;
        let shouldReplaceBody = false;
        let meta = null;
        try {
            meta = xhrOpenMeta.get(this);
            if (meta && JSON_BODY_METHODS.has(meta.method)) {
                const plan = planXhrBodyModification(meta.url, meta.method, body);
                recordDecision(plan);
                if (plan.changed) {
                    replacementBody = plan.replacementBody;
                    shouldReplaceBody = true;
                }
            }
        } catch (error) {
            /* 保护逻辑自身异常：放弃修改，原样发送（不重复发送） */
            recordDecision({
                changed: false,
                decision: 'modification-failed',
                reason: '插件修改阶段发生异常',
                url: meta ? meta.url : '',
                errorStage: 'modify',
                errorMessage: error && error.message ? error.message : String(error),
            });
        }

        if (!shouldReplaceBody) return originalSend.apply(this, arguments);
        /* 文本使用修改后的字符串，普通对象继续保留对象形式；原 send 抛错时保持原异常，不重发 */
        return originalSend.call(this, replacementBody);
    };

    try {
        proto.open = hookedOpen;
        proto.send = hookedSend;
    } catch (error) {
        return false;
    }
    hookedXhrProtos.set(realmWindow, { open: hookedOpen, send: hookedSend });
    return true;
}

/* 统计已安装 XHR 包装的 realm 数（主窗口 + 同源 iframe，供调试接口使用） */
function countXhrHookedRealms() {
    let count = hookedXhrProtos.has(window) ? 1 : 0;
    document.querySelectorAll('iframe').forEach((frame) => {
        try {
            if (frame.contentWindow && hookedXhrProtos.has(frame.contentWindow)) count++;
        } catch (error) {
            /* 跨域 iframe 跳过 */
        }
    });
    return count;
}

/* ── Hook 安装 ────────────────────────── */

/* 安装主窗口请求拦截（fetch + XHR）：两套包装都始终安装 */
function installMainRequestHooks() {
    if (mainHookInstalled) return;

    if (typeof window.fetch === 'function') {
        const originalFetch = window.fetch;
        const hook = createFetchHook(window, () => originalFetch);
        window.fetch = hook;
        hookedFetchHooks.set(window, hook);
    } else {
        logWarn('主窗口 fetch 不可用，暂未安装 fetch 拦截');
    }

    installRealmXhrHook(window);
    hookedWindows.add(window);
    mainHookInstalled = true;

    logInfo('主窗口请求拦截已安装（fetch + XHR）');
}

/* 给单个同源 iframe 安装请求包装（fetch + XHR） */
function hookIframeRequests(iframe) {
    if (!iframe) return false;

    if (!iframe.contentWindow) {
        if (!iframeLoadListenersAttached.has(iframe)) {
            iframeLoadListenersAttached.add(iframe);
            iframe.addEventListener('load', () => hookIframeRequests(iframe));
        }
        return false;
    }

    const iframeWindow = iframe.contentWindow;
    try {
        void iframeWindow.document;
    } catch (error) {
        logWarn('跨域 iframe 无法读取，已跳过', iframe.src || '');
        return false;
    }

    /* fetch 包装：已装且未被替换则跳过，避免破坏该 realm 的包装链 */
    let fetchReady = false;
    const existingHook = hookedFetchHooks.get(iframeWindow);
    if (existingHook && iframeWindow.fetch === existingHook) {
        fetchReady = true;
    } else if (typeof iframeWindow.fetch === 'function') {
        const originalFetch = iframeWindow.fetch;
        const hook = createFetchHook(iframeWindow, () => originalFetch);
        iframeWindow.fetch = hook;
        hookedFetchHooks.set(iframeWindow, hook);
        fetchReady = true;
    }

    /* XHR 包装：同一个 realm 只装一次，已装且未被替换则跳过 */
    const xhrReady = installRealmXhrHook(iframeWindow);
    if (!fetchReady && !xhrReady) return false;

    if (!hookedWindows.has(iframeWindow)) {
        hookedWindows.add(iframeWindow);
        iframeHookCount++;
    }

    if (!iframeLoadListenersAttached.has(iframe)) {
        iframeLoadListenersAttached.add(iframe);
        iframe.addEventListener('load', () => hookIframeRequests(iframe));
    }

    logInfo('同源 iframe 请求拦截已安装（fetch + XHR）', iframe.src || iframe.id || '');
    return true;
}

/* 安装 iframe 请求 hook（fetch + XHR）：初始扫描 + 动态监听 */
function installIframeRequestHooks() {
    if (iframeHooksInstalled) return;
    iframeHooksInstalled = true;

    let scannedCount = 0;
    let hookedCount = 0;
    for (const iframe of document.querySelectorAll('iframe')) {
        scannedCount++;
        if (hookIframeRequests(iframe)) hookedCount++;
    }

    const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node.nodeType !== 1) continue;
                if (node.tagName === 'IFRAME') {
                    hookIframeRequests(node);
                } else if (node.querySelectorAll) {
                    for (const inner of node.querySelectorAll('iframe')) {
                        hookIframeRequests(inner);
                    }
                }
            }
        }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    logInfo(`iframe 请求 hook 扫描完成（fetch + XHR，初始 ${hookedCount}/${scannedCount} 个）`);
}

/* ── 调试接口 ─────────────────────────── */

window.__PrefillCompatFix = {
    inspect: inspectRequestBody,
    getLastDecision: () => lastDecision,
    getLastBodyDescriptor: () => (lastBodyDescriptor ? { ...lastBodyDescriptor } : null),
    getRequestPipelineStats: () => ({ ...requestPipelineStats }),
    resetRequestPipelineStats: () => {
        requestPipelineStats.requestReads = 0;
        requestPipelineStats.jsonParses = 0;
        requestPipelineStats.analyses = 0;
        requestPipelineStats.modifications = 0;
    },
    getModelList: () => ({
        effective: getEffectiveModelPatterns(),
        builtin: MODEL_PATTERNS.slice(),
        stored: getModelListStored(),
    }),
    /* 测试用：把「一行一条」的文本按正式流程清洗并写入设置 */
    applyModelListText: (text) => {
        const info = normalizeModelListInput(text);
        const saved = saveModelListSettings(info.lines);
        return { lines: info.lines, fixes: info.fixes, issues: info.issues, saved };
    },
    getHookCount: () => ({
        main: mainHookInstalled ? 1 : 0,
        iframes: iframeHookCount,
        xhr: countXhrHookedRealms(),
        total: (mainHookInstalled ? 1 : 0) + iframeHookCount,
    }),
};

/* ── 初始化 ───────────────────────────── */

/* 读取 ST 上下文；未就绪时返回 null */
function getStContext() {
    try {
        if (!window.SillyTavern || typeof window.SillyTavern.getContext !== 'function') {
            return null;
        }
        return window.SillyTavern.getContext();
    } catch (error) {
        return null;
    }
}

/* 安装全部 hook（重复调用安全） */
function installAllHooks() {
    installMainRequestHooks();
    installIframeRequestHooks();
    installModelListLinkWithRetry();
    checkBuiltinListUpdateOnce();
    logStartupOnce();
}

/* 注入设置链接：ST 界面或插件加载顺序可能稍晚，带重试 + 兜底观察 */
function installModelListLinkWithRetry() {
    if (installModelListLink()) return;

    let attempts = 0;
    const timer = setInterval(() => {
        attempts += 1;
        if (installModelListLink() || attempts >= 20) {
            clearInterval(timer);
        }
    }, 500);

    /* 仍未注入时，用观察器等目标行出现（例如自定义主题或后续 DOM 变动） */
    const observer = new MutationObserver(() => {
        if (installModelListLink()) {
            observer.disconnect();
        }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
}

/* 等待 ST 就绪（APP_READY）后安装，尽量排在其它扩展之后；已错过时用兜底延时安装 */
function scheduleHookInstall() {
    const context = getStContext();
    const eventSource = context && context.eventSource;
    const eventTypes = context && context.event_types;

    if (eventSource && eventTypes && eventTypes.APP_READY) {
        eventSource.once(eventTypes.APP_READY, () => {
            setTimeout(installAllHooks, 0);
        });
        setTimeout(installAllHooks, APP_READY_FALLBACK_MS);
        logInfo('等待 APP_READY 后安装请求拦截（fetch + XHR）');
        return;
    }

    setTimeout(installAllHooks, APP_READY_FALLBACK_MS);
    logInfo('ST 上下文暂不可用，使用兜底时机安装请求拦截（fetch + XHR）');
}

scheduleHookInstall();
