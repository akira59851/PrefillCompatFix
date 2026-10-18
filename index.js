/* ============================================================
   预填充兼容修复 (PrefillCompatFix) — 主逻辑模块（index.js）
   ============================================================ */

/* 【区块索引】（按文件从上到下的顺序）
   1. 可调参数与常量     模型名单、占位内容、安装时机
   2. 模型清单设置       用户自定义清单的存储、合并、弹窗与入口注入
   3. 状态变量           挂钩状态与最近一次判断结果
   4. 日志工具           统一日志前缀与级别
   5. 基础工具           请求对象、URL、Header、模型名等纯函数
   6. 模型名提取         按明确优先级收集候选并返回最终来源
   7. 消息数组选择       在 messages / contents 之间做单目标选择
   8. 请求体分析与修改   纯判断、追加 user、构造 modified init
   9. Fetch 请求拦截     主窗口与同源 iframe 共用包装逻辑
   10. XHR 请求拦截       open/send 包装与同步补全判定
   11. Hook 安装         主窗口、同源 iframe、动态 iframe（fetch + XHR）
   12. 调试接口          测试与排查用的 window.__PrefillCompatFix
   13. 初始化            等待 ST 就绪后安装
   ============================================================ */

/* ── 可调参数与常量 ───────────────────── */

const PLUGIN_KEY = 'PrefillCompatFix';
const PLUGIN_DISPLAY_NAME = '预填充兼容修复';
const ENABLED = true;                  /* 总开关：当前版本默认启用 */
const DEBUG_LOGS = false;              /* 是否输出详细调试日志 */
const PLACEHOLDER_TEXT = ' ';          /* 追加消息内容：必须是非空字符串 */
const APP_READY_FALLBACK_MS = 1200;    /* APP_READY 已错过时的单次兜底安装延时(ms) */
const JSON_BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);

/* 默认保护名单：实际模型名包含任一配置项即命中，不区分大小写。
   设置弹窗会在内置名单基础上合并自定义与删除记录，得到最终生效清单 */
const MODEL_PATTERNS = [
    /* Google Gemini */
    'gemini-3.5-flash-lite',
    'gemini-3.6-flash',
    'gemini-3.7-flash',
    'gemini-3.8-flash',
    'gemini-4-argon',

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
];

/* ── 模型清单设置 ─────────────────────── */

const MODEL_LIST_INPUT_ID = 'pcf-model-list-input';
const MODEL_LIST_MAX_LINES = 100;      /* 清单行数上限，防止整段粘贴灌爆设置文件 */
const MODEL_LIST_LINK_ID = 'pcf-model-list-link';
const MODEL_LIST_LINK_PUSH_ID = 'pcf-model-list-push';
/* 不可见字符：控制字符 + 常见零宽/双向格式字符；空白类字符另行归一为半角空格 */
const INVISIBLE_CHAR_RE = /[\u0000-\u0008\u000E-\u001F\u007F-\u009F\u00AD\u034F\u061C\u17B4-\u17B5\u180B-\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\uFFF9-\uFFFB]/g;
/* 需要当成空格处理的空白（换行与全角空格在切分前/后单独处理） */
const SPACE_LIKE_RE = /[\t\f\v\u00A0\u1680\u2000-\u200A\u202F\u205F]/g;

/* 从 ST 设置中读取自定义与删除记录；结构异常时按空处理 */
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

/* 把清洗结果写回 ST 设置；custom = 非内置条目，removed = 被删掉的内置条目 */
function saveModelListSettings(lines) {
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

    context.extensionSettings[PLUGIN_KEY] = { custom, removed };
    if (typeof context.saveSettingsDebounced === 'function') {
        context.saveSettingsDebounced();
    }
    return true;
}

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

/* 构造弹窗正文：标题、说明与可调整高度的清单输入框 */
function buildModelListDialogContent(initialText) {
    const content = document.createElement('div');
    content.className = 'flex-container flexFlowColumn height100p';

    const title = document.createElement('h3');
    title.className = 'margin0 flex-container flexFlowColumn textAlignCenter';
    title.textContent = PLUGIN_DISPLAY_NAME;

    const area = document.createElement('div');
    area.className = 'flex1 flex-container flexFlowColumn';

    const hint = document.createElement('h4');
    hint.className = 'margin0';
    hint.textContent = '生效模型清单（每行一个，保存生效，无需刷新）';

    const textarea = document.createElement('textarea');
    textarea.id = MODEL_LIST_INPUT_ID;
    textarea.className = 'text_pole';
    textarea.placeholder = '示例：\ngemini-3.7-flash\ngemini-3.8-flash\ngemini-4-argon';
    textarea.spellcheck = false;
    textarea.value = initialText;
    /* 保留较高的默认高度和下方空间，并允许用户拖拽调整 */
    textarea.style.height = '60vh';
    textarea.style.minHeight = '8em';
    textarea.style.maxHeight = '75vh';

    area.appendChild(hint);
    area.appendChild(textarea);
    content.appendChild(title);
    content.appendChild(area);
    return { content, textarea };
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
    /* 已保存内容；取消或校验失败后恢复为它 */
    let savedText = getModelListText();
    let initialText = savedText;

    while (true) {
        const parts = buildModelListDialogContent(initialText);
        /* null：正常关闭；restore：恢复默认；cancel：取消或拒绝确认 */
        let closingWithResult = null;
        /* 是否正在等待保存校验 */
        let savePending = false;

        const popup = new PopupClass(parts.content, popupType.TEXT, '', {
            wide: true,
            large: true,
            allowVerticalScrolling: true,
            okButton: false,
            cancelButton: false,
            customButtons: [
                { text: '保存', classes: ['popup-button-ok'], action: () => { savePending = true; popup.completeAffirmative(); } },
                { text: '取消', classes: ['popup-button-cancel'], result: resultTypes.NEGATIVE, appendAtEnd: true },
                { text: '恢复默认', action: () => { void handleRestore(); }, appendAtEnd: true },
            ],
            onClosing: async (instance) => {
                /* 保存前校验；不通过时保持弹窗并保留输入 */
                if (savePending) {
                    const ok = await confirmModelListIssues(parts.textarea.value);
                    if (!ok) {
                        savePending = false;
                        return false;
                    }
                    closingWithResult = resultTypes.AFFIRMATIVE;
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
            closingWithResult = 'restore';
            await popup.completeCancelled();
        };

        await popup.show();

        if (closingWithResult === 'restore') {
            /* 恢复默认后重新打开弹窗，等待用户确认保存 */
            initialText = MODEL_PATTERNS.join('\n');
            continue;
        }

        if (closingWithResult === resultTypes.AFFIRMATIVE) {
            const info = normalizeModelListInput(parts.textarea.value);
            const saved = saveModelListSettings(info.lines);
            if (!saved) {
                logWarn('保存模型清单失败：ST 设置接口不可用');
            }
            savedText = info.lines.join('\n');
            return;
        }

        return;
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

/* 分析已解析的 JSON 请求体，只做判断，不修改 */
function analyzeParsedBody(body, requestUrl) {
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

/* 返回追加单空格 user 消息后的新请求体，不修改传入对象 */
function buildFixedBody(body, target) {
    if (target === 'messages') {
        return {
            ...body,
            messages: [
                ...body.messages,
                { role: 'user', content: PLACEHOLDER_TEXT },
            ],
        };
    }

    return {
        ...body,
        contents: [
            ...body.contents,
            { role: 'user', parts: [{ text: PLACEHOLDER_TEXT }] },
        ],
    };
}

/* 读取本次 fetch 实际生效的请求体文本 */
async function readEffectiveRequestBody(input, init) {
    if (init && Object.prototype.hasOwnProperty.call(init, 'body')) {
        if (typeof init.body === 'string') {
            return { ok: true, text: init.body, source: 'init.body' };
        }
        return { ok: false, reason: 'init.body 不是字符串' };
    }

    if (!isRequestLike(input)) {
        return { ok: false, reason: '输入不是 Request 且 init.body 不可用' };
    }

    try {
        const clonedRequest = input.clone();
        const text = await clonedRequest.text();
        return { ok: true, text, source: 'request.body' };
    } catch (error) {
        return { ok: false, reason: 'Request body 无法 clone 或读取' };
    }
}

/* 用修改后的文本构造新的 fetch init，只覆盖 body */
function buildModifiedInit(init, bodyText) {
    if (init && typeof init === 'object') {
        return { ...init, body: bodyText };
    }
    return { body: bodyText };
}

/* 分析并构造修改后的请求参数；任何无法安全完成的情况都返回 changed:false */
async function buildModifiedFetchArgs(input, init) {
    const requestUrl = getFetchRequestUrl(input);
    const method = getEffectiveMethod(input, init);

    if (!JSON_BODY_METHODS.has(method)) {
        return {
            changed: false,
            decision: 'unsupported-body',
            reason: `method ${method} 不是 JSON 写请求`,
            url: requestUrl,
        };
    }

    const contentType = getEffectiveContentType(input, init);
    if (!isJsonContentType(contentType)) {
        return {
            changed: false,
            decision: 'unsupported-body',
            reason: `Content-Type ${contentType} 不是 JSON`,
            url: requestUrl,
        };
    }

    const bodyRead = await readEffectiveRequestBody(input, init);
    if (!bodyRead.ok) {
        return {
            changed: false,
            decision: 'unsupported-body',
            reason: bodyRead.reason,
            url: requestUrl,
        };
    }

    let body;
    try {
        body = JSON.parse(bodyRead.text);
    } catch (error) {
        return {
            changed: false,
            decision: 'unsupported-body',
            reason: '请求体不是合法 JSON',
            url: requestUrl,
        };
    }

    if (!isPlainObject(body)) {
        return {
            changed: false,
            decision: 'unsupported-body',
            reason: '请求体 JSON 顶层不是普通对象',
            url: requestUrl,
        };
    }

    const analysis = analyzeParsedBody(body, requestUrl);
    if (analysis.decision !== 'needs-fix') {
        return {
            ...analysis,
            changed: false,
            url: requestUrl,
            body,
        };
    }

    const fixedBody = buildFixedBody(body, analysis.target);
    const fixedBodyText = JSON.stringify(fixedBody);

    return {
        ...analysis,
        changed: true,
        decision: 'fixed',
        url: requestUrl,
        body: fixedBody,
        modifiedInit: buildModifiedInit(init, fixedBodyText),
    };
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

    const analysis = analyzeParsedBody(body, requestUrl || '');
    if (analysis.decision !== 'needs-fix') {
        return { ...analysis, url: requestUrl || '', body };
    }

    const fixedBody = buildFixedBody(body, analysis.target);
    return {
        ...analysis,
        changed: true,
        decision: 'fixed',
        url: requestUrl || '',
        body: fixedBody,
    };
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

/* 同步构造 XHR 请求体的修改方案；发送方法是同步的，不能复用异步 fetch 流程。
   判断条件与 fetch 一致，无法安全修改时返回 changed:false */
function planXhrBodyModification(requestUrl, method, bodyText) {
    if (!JSON_BODY_METHODS.has(method)) {
        return {
            changed: false,
            decision: 'unsupported-body',
            reason: `method ${method} 不是 JSON 写请求`,
            url: requestUrl,
        };
    }

    let body;
    try {
        body = JSON.parse(bodyText);
    } catch (error) {
        return {
            changed: false,
            decision: 'unsupported-body',
            reason: '请求体不是合法 JSON',
            url: requestUrl,
        };
    }

    if (!isPlainObject(body)) {
        return {
            changed: false,
            decision: 'unsupported-body',
            reason: '请求体 JSON 顶层不是普通对象',
            url: requestUrl,
        };
    }

    const analysis = analyzeParsedBody(body, requestUrl);
    if (analysis.decision !== 'needs-fix') {
        return { ...analysis, changed: false, url: requestUrl, body };
    }

    const fixedBody = buildFixedBody(body, analysis.target);
    return {
        ...analysis,
        changed: true,
        decision: 'fixed',
        url: requestUrl,
        body: fixedBody,
        fixedBodyText: JSON.stringify(fixedBody),
    };
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

        /* 需要修改时的请求文本；null 表示按原参数发送 */
        let modifiedBodyText = null;
        let meta = null;
        try {
            meta = xhrOpenMeta.get(this);
            /* 只处理字符串 body：Blob、FormData、ArrayBuffer 等无法安全改写，原样放行 */
            if (typeof body === 'string' && body && meta && JSON_BODY_METHODS.has(meta.method)) {
                const plan = planXhrBodyModification(meta.url, meta.method, body);
                recordDecision(plan);
                if (plan.changed) modifiedBodyText = plan.fixedBodyText;
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

        if (modifiedBodyText === null) return originalSend.apply(this, arguments);
        /* 使用修改后的文本发送；原 send 抛错时保持原异常，不重发 */
        return originalSend.call(this, modifiedBodyText);
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
