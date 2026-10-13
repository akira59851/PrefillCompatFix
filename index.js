/* ============================================================
   预填充兼容修复 (PrefillCompatFix) — 主逻辑模块（index.js）
   ============================================================ */

/* 【区块索引】（按文件从上到下的顺序）
   1. 可调参数与常量     模型名单、占位内容、安装时机
   2. 状态变量           挂钩状态与最近一次判断结果
   3. 日志工具           统一日志前缀与级别
   4. 基础工具           请求对象、URL、Header、模型名等纯函数
   5. 模型名提取         按明确优先级收集候选并返回最终来源
   6. 消息数组选择       在 messages / contents 之间做单目标选择
   7. 请求体分析与修改   纯判断、追加 user、构造 modified init
   8. Fetch 请求拦截     主窗口与同源 iframe 共用包装逻辑
   9. XHR 请求拦截       open/send 包装与同步补全判定
   10. Hook 安装         主窗口、同源 iframe、动态 iframe（fetch + XHR）
   11. 调试接口          测试与排查用的 window.__PrefillCompatFix
   12. 初始化            等待 ST 就绪后安装
   ============================================================ */

/* ── 可调参数与常量 ───────────────────── */

const PLUGIN_KEY = 'PrefillCompatFix';
const ENABLED = true;                  /* 总开关：当前版本默认启用 */
const DEBUG_LOGS = false;              /* 是否输出详细调试日志 */
const PLACEHOLDER_TEXT = ' ';          /* 追加消息内容：必须是非空字符串 */
const APP_READY_FALLBACK_MS = 1200;    /* APP_READY 已错过时的单次兜底安装延时(ms) */
const JSON_BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);

/* 默认保护名单：实际模型名包含任一配置项即命中；不区分大小写 */
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

/* ── 状态变量 ─────────────────────────── */

/* WeakMap<Window, Function>: 已安装包装的窗口 → 包装函数 */
const hookedFetchHooks = new WeakMap();
/* WeakMap<XMLHttpRequest, {method, url}>: XHR 实例的 open 参数（send 时读取；重复 open 覆盖） */
const xhrOpenMeta = new WeakMap();
/* WeakMap<Window, {open, send}>: 已安装 XHR 包装的 realm（主窗口 + 同源 iframe）→ 安装时的原型方法，
   用途与 hookedFetchHooks 相同：防同一 realm 重复包装；iframe 重载或原型被替换后重新包装 */
const hookedXhrProtos = new WeakMap();
/* WeakSet<Window>: 已经计入统计的窗口，避免同一窗口重复计数 */
const hookedWindows = new WeakSet();
/* WeakSet<HTMLIFrameElement>: 已挂 load 监听的 iframe，避免重复绑定 */
const iframeLoadListenersAttached = new WeakSet();

/* boolean: 主窗口 hook（fetch + XHR）是否已安装 */
let mainHookInstalled = false;
/* boolean: iframe hook（fetch + XHR）扫描器是否已安装 */
let iframeHooksInstalled = false;
/* number: 已安装 hook 的 iframe 窗口数量（用于调试） */
let iframeHookCount = 0;
/* object|null: 最近一次请求的简要判断结果 */
let lastDecision = null;
/* boolean: 启动成功提示是否已输出过 */
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

/* 判断是否为普通对象（排除数组与 null） */
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

/* 获取 URL 的 pathname；失败时返回空字符串 */
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

/* 获取本次 fetch 实际生效的 method */
function getEffectiveMethod(input, init) {
    if (init && typeof init.method === 'string' && init.method) {
        return init.method.toUpperCase();
    }
    if (isRequestLike(input) && typeof input.method === 'string' && input.method) {
        return input.method.toUpperCase();
    }
    return 'GET';
}

/* 获取本次 fetch 实际生效的 Content-Type */
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

/* 安全解码 URL 片段 */
function safeDecodeURIComponent(value) {
    if (typeof value !== 'string') return '';
    try {
        return decodeURIComponent(value);
    } catch (error) {
        return value;
    }
}

/* 规范化模型名 */
function normalizeModelName(value) {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/* 规范化消息角色 */
function normalizeRole(value) {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/* 返回第一个命中的配置项；未命中返回空字符串 */
function findMatchedModelPattern(modelName) {
    const normalizedModel = normalizeModelName(modelName);
    if (!normalizedModel) return '';

    for (const pattern of MODEL_PATTERNS) {
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

/* 把 open 收到的地址按该 realm 自身的 location 解析为绝对地址（主窗口与 iframe 的 location 不同） */
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

/* 同步判定一次 XHR 请求体是否需要补全（send 是同步的，不能走 async 的 fetch 流程）。
   判据与 fetch 相同、不是「能解析成 JSON」就改：写方法 + 目标 URL + 请求体结构 + 模型命中名单；
   任何一步不满足都返回 changed:false，保持原请求不变。 */
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

/* 给单个 realm 安装 XHR 包装（主窗口与同源 iframe 共用）：open 记录方法与地址（相对地址按该 realm
   自身 location 解析为绝对）；send 里同步判定，需要补全时用改后的文本调用原 send，否则保持原参数。
   同一 realm 只装一次：已装且原型方法未被替换就跳过；iframe 重载或内部脚本替换原型后重新包装。
   保护逻辑自身异常时按原请求发送；原 send 自身抛错时保持原异常、不重发。 */
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

        /* string|null: 需要补全时替换后的请求文本；保持 null 表示按原参数发送 */
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
        /* 用改后文本发送；原 send 自身抛错时保持原异常行为，不重发 */
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
    logStartupOnce();
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
