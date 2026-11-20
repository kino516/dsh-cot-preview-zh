/**
 * dsh-cot-preview-zh — 折叠思考预览行的中文翻译（客户端半边）。
 *
 * 背景：官方 `@deepseek-ai/dsh-experimental-client-ui-cot-translation` 只翻「展开后的思考正文」，
 * 折叠状态那一行预览是 `ReasoningRow` 内部用 firstLine(reasoning) 就地拼出来的，没有 Slot 可挂。
 * 本插件因此在展示层补一层：找到折叠行的预览文本 → 走官方 Host 端 `cotTranslation` 远程方法翻译
 * （浏览器直连 Bing/Google 会被 CORS 挡住，必须由 Host 发请求）→ 用译文替换那一行的显示文本。
 *
 * 行为约定：
 *   · 只处理非展开的思考行（`data-variant="think"` 且没有 `data-expanded`）；
 *   · 已经是中文的预览不送翻译（避免无意义请求）；
 *   · 流式思考等文本稳定 700ms 再翻；命中缓存/在途请求不重复发；
 *   · 翻译失败保留英文原文，5 分钟内不重试；
 *   · 原文节点只是被隐藏，随时可还原；卸载时全部还原并断开观察；
 *   · 工具折叠行走另一条路：只把 `data-tool` 里的英文 wire 工具名换成中文标签
 *     （`工具 · ops_bash · ls -la` → `执行命令 · ls -la`），参数/命令/路径一个字符都不改；
 *   · 3 秒后仍没有任何一行翻译成功时，打一条 error 级诊断（DSH 桌面端会把渲染进程的
 *     error 级 console 转发到 ~/.dsh/logs/desktop-next.log），便于定位是缺 sessionId、
 *     还是没匹配到思考行/预览锚点。健康的页面上不会输出这条诊断。
 *
 * 已知代价（明确写在这里，不藏）：
 *   · 这是 DOM 层补丁 —— DSH 升级若改了思考行的结构（分隔符/预览节点）需要跟着改；
 *   · 译文会发给所选翻译服务（默认 Bing），与官方展开翻译同一条通路。
 */
window.__ModuleLoader__.load({
  id: 'dsh-cot-preview-zh',
  factory() {
    /** 思考行的稳定锚点：ReasoningRow 根节点带 data-variant="think"。 */
    const ROW_SELECTOR = '[data-variant="think"]';
    /** 折叠内容里的装饰分隔符，紧邻预览容器。 */
    const SEPARATOR_SELECTOR = '[data-shimmer-decoration]';
    /** 我们自己插入的译文节点。 */
    const OWN_ATTR = 'data-cot-preview-zh';
    /** 打在被替换的原文节点上，仅用于隐藏。 */
    const HIDDEN_ATTR = 'data-cot-preview-zh-hidden';
    /** 注入的样式表 id。 */
    const STYLE_ID = 'dsh-cot-preview-zh-style';
    /** 工具行根节点带 data-tool="<wire tool name>"。 */
    const TOOL_ROW_SELECTOR = '[data-tool]';

    /**
     * 工具名 → 中文标签。
     *
     * 只替换折叠行里的**工具名前缀**（DSH 对未登记的工具会把 wire 名拼进摘要，
     * 见 `dsh-client-ui-tool` 的 `tool-call-model.ts`：`summary = [generic ? toolName : '', base].join(' · ')`）。
     * 参数、命令、路径、query 一律原样保留——机翻它们会破坏可复制性，甚至让命令失真。
     */
    const TOOL_LABELS = {
      ops_bash: '执行命令',
      ops_inspect_local_file: '读取文件',
      ops_grep: '搜索内容',
      ops_glob: '查找文件',
      plugin_manager: '插件管理',
      skill: '加载技能',
      todo_write: '记录待办',
      ask_user_question: '询问用户',
      present: '交付文件',
      write: '写入文件',
      edit: '编辑文件',
      get_goal: '读取目标',
      create_goal: '创建目标',
      update_goal: '更新目标',
      load_workspace_dependencies: '加载工作区依赖',
      windows_encode_detect: '诊断文件编码',
      windows_encode_fix: '修复文件编码',
      web_search: '网络搜索',
      web_fetch: '抓取网页',
      job_list: '列出后台任务',
      job_output: '读取任务输出',
      job_kill: '停止任务',
      terminal_open: '打开终端',
      terminal_read: '读取终端',
      terminal_send: '向终端输入',
      terminal_signal: '发送信号',
      terminal_close: '关闭终端',
      terminal_list: '列出终端',
      subagent: '派发子代理',
      subagent_fork: '派发子代理（继承上下文）',
      subagent_oar: '派发外部代理',
      list_agents: '列出代理',
      send_message: '给代理发消息',
      wait_agent: '等待代理',
      workflow: '运行工作流',
      schedule_create: '新建定时任务',
      schedule_edit: '编辑定时任务',
      schedule_list: '列出定时任务',
      schedule_view: '查看定时任务',
      remote_list_hosts: '列出远程主机',
      remote_list_workspaces: '列出远程工作区',
      remote_list_sessions: '列出远程会话',
      remote_list_presets: '列出远程预设',
      remote_select_preset: '选择远程预设',
      remote_create_session: '新建远程会话',
      remote_send_message: '远程发消息',
      remote_read_session: '读取远程会话',
      remote_wait_sessions: '等待远程会话',
      remote_interrupt_session: '中断远程会话',
      remote_download_file: '下载远程文件',
      remote_upload_file: '上传远程文件',
      remote_get_operation: '查询远程操作',
    };

    /** 内置浏览器工具（`dsh_browser_*`）的动词标签。 */
    const BROWSER_LABELS = {
      open: '打开页面', refresh: '刷新页面', back: '后退', forward: '前进',
      click: '点击', click_sequence: '连续点击', type: '输入文本', fill: '填写表单',
      set_value: '设置字段值', clear: '清空输入', check: '勾选', select: '选择选项',
      get_value: '读取字段值', key: '按键', hover: '悬停', drag: '拖拽', scroll: '滚动',
      a11y: '读取无障碍树', snapshot: '读取页面结构', screenshot: '截图', content: '读取页面内容',
      scrape: '抓取结构化数据', state: '读取页面状态', find: '页内查找', assert: '断言页面',
      wait: '等待加载', wait_for_response: '等待响应', console: '读取控制台', network: '查看网络请求',
      execute: '执行脚本', dialog: '处理对话框', challenge: '检查验证码', doctor: '诊断浏览器',
      upload: '上传文件', download: '下载文件', list_tabs: '列出标签页', switch_tab: '切换标签页',
      close_tab: '关闭标签页', session: '会话信息', reset: '重置浏览器', reset_session: '重置会话',
      restrict: '限制工具', history: '操作历史', replay: '重放操作', visited: '访问记录',
      help: '帮助', auth: '会话凭据',
    };

    /**
     * 把 wire 工具名解析成中文标签。
     * @param name - `data-tool` 的值。
     * @returns 中文标签；没有映射时原样返回（不改动未知工具）。
     */
    function toolLabel(name) {
      if (typeof name !== 'string' || name === '') return name;
      const exact = TOOL_LABELS[name];
      if (exact !== undefined) return exact;
      const browser = /^dsh_browser_(.+)$/.exec(name);
      if (browser !== null) {
        const verb = BROWSER_LABELS[browser[1]];
        if (verb !== undefined) return '浏览器·' + verb;
      }
      const ops = /^ops_(.+)$/.exec(name);
      if (ops !== null) {
        const same = TOOL_LABELS['ops_' + ops[1]];
        if (same !== undefined) return same;
      }
      return name;
    }
    /** 本地译文缓存条目上限。 */
    const CACHE_LIMIT = 400;
    /** 单次翻译请求的超时。 */
    const REQUEST_TIMEOUT_MS = 30000;
    /** 流式思考的稳定等待时间。 */
    const STREAM_DEBOUNCE_MS = 700;
    /** 失败后多久才允许对同一段文本重试。 */
    const RETRY_AFTER_MS = 5 * 60 * 1000;
    /** 合并 DOM 变更的扫描节流。 */
    const SCAN_DEBOUNCE_MS = 120;
    /** 一直没有翻译成功时的诊断时刻（毫秒，自挂载起算）。 */
    const DIAGNOSE_AT_MS = [3000, 10000];

    /**
     * 判断文本是否已经是中文，用于跳过无意义的翻译请求。
     * @param text - 预览原文。
     * @returns 中日韩表意字符占比是否达到 30%。
     */
    function looksChinese(text) {
      const cjk = text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g);
      if (cjk === null) return false;
      const visible = text.replace(/\s/g, '').length;
      return visible > 0 && cjk.length / visible >= 0.3;
    }

    /**
     * 读取预览的原始文本。
     * TextShimmer 在有活动状态时会额外渲染一份 `aria-hidden`/`inert` 的装饰副本，
     * 必须排除，否则文本会重复两遍。
     * @param textHost - 承载预览文本的节点。
     * @returns 归一化后的原文。
     */
    function readSummary(textHost) {
      if (!textHost) return '';
      const root = textHost.firstElementChild;
      if (!root) return (textHost.textContent || '').replace(/\s+/g, ' ').trim();
      let out = '';
      for (const child of root.children) {
        if (child.getAttribute('aria-hidden') === 'true' || child.hasAttribute('inert')) continue;
        out += ' ' + (child.textContent || '');
      }
      return (out.trim() !== '' ? out : root.textContent || '').replace(/\s+/g, ' ').trim();
    }

    /**
     * 找到承载摘要文本的文本节点（沿第一个非装饰元素逐层下降）。
     * @param textHost - 预览/摘要容器。
     * @returns 文本节点，或结构不匹配时的 null。
     */
    function summaryTextNode(textHost) {
      let node = textHost;
      for (let depth = 0; depth < 6; depth += 1) {
        let next = null;
        for (const child of node.childNodes) {
          if (child.nodeType === 3) {
            if ((child.nodeValue || '').trim() !== '') return child;
            continue;
          }
          if (child.nodeType !== 1) continue;
          if (child.getAttribute('aria-hidden') === 'true' || child.hasAttribute('inert')) continue;
          next = child;
          break;
        }
        if (next === null) return null;
        node = next;
      }
      return null;
    }

    /**
     * 定位一行思考的预览容器与原文节点。
     * 结构锚点：折叠内容里的 `[data-shimmer-decoration]`（装饰分隔符）紧邻预览容器，
     * 预览容器第一个元素子是原文节点。CSS module 类名是哈希值，因此不用类名定位。
     * @param row - 带 data-variant="think" 的思考行。
     * @returns 两个节点，或结构不匹配时的 null。
     */
    function queryParts(row) {
      const decoration = row.querySelector(SEPARATOR_SELECTOR);
      if (!decoration) return null;
      const summary = decoration.nextElementSibling;
      if (!summary || summary.nodeType !== 1) return null;
      const textHost = summary.firstElementChild;
      if (!textHost) return null;
      if (textHost.hasAttribute(OWN_ATTR)) return null;
      return { summary, textHost };
    }

    return {
      // Cordis 的服务注入按属性名白名单校验，父子两级都要声明：
      // 'remote' 允许访问 ctx.remote 本身，'remote.cotTranslation' 允许访问该子服务
      // （官方 cot-translation 插件同样是外层 inject 'remote' + 内层 ctx.inject(['remote.cotTranslation', ...])）。
      inject: ['slots', 'remote', 'remote.cotTranslation', 'locale'],
      apply(ctx) {
        const state = {
          /** 当前可见会话 id：翻译结果按会话存放在 Host 侧。 */
          sessionId: undefined,
          disposed: false,
          /** 已完成译文：原文 → 译文。 */
          cache: new Map(),
          /** 在途请求：原文 → Promise<string>。 */
          inflight: new Map(),
          /** 失败冷却：原文 → 可重试时间戳。 */
          failures: new Map(),
          /** Host 侧偏好与长度限制（来自 cotTranslation.limits）。 */
          meta: undefined,
          /** 每行最近一次看到的原文。 */
          lastSeen: new WeakMap(),
          /** 每行已经替换上去的原文，用于避免重复写入。 */
          painted: new WeakMap(),
          /** 每行的去抖定时器。 */
          timers: new Map(),
          /** 已经交给 IntersectionObserver 的行。 */
          observed: new WeakSet(),
          /** 成功替换的行数（含重复替换），仅用于诊断。 */
          paintedCount: 0,
          /** 成功改写成中文标签的工具行数，仅用于诊断。 */
          rewrittenCount: 0,
          /** 已经报告过的失败原因，避免刷日志。 */
          reported: new Set(),
        };

        let scanTimer = 0;
        let intersection = null;
        /** remoteService() 最近一次被 guard 拦下的原因，仅用于诊断。 */
        let remoteAccessError;
        /** 当前在视口内（含 200px 预取）的思考行。 */
        const visible = new WeakSet();

        /** 取官方 cotTranslation 远程方法；bundle 未启用时为 undefined。 */
        function remoteService() {
          try {
            const remote = ctx.remote;
            if (!remote) return undefined;
            const service = remote.cotTranslation;
            return service === undefined ? undefined : service;
          } catch (error) {
            remoteAccessError = error && error.message ? error.message : String(error);
            return undefined;
          }
        }

        /** 只报告一次同类失败，并通过 error 级别转发到宿主日志。 */
        function report(reason, extra) {
          if (state.reported.has(reason)) return;
          state.reported.add(reason);
          try {
            console.error('[cot-preview-zh] ' + reason + ' ' + JSON.stringify(extra || {}));
          } catch (_error) {
            /* 控制台不可用时静默。 */
          }
        }

        /** 读取当前界面语言，作为 targetLanguage=auto 时的实际目标语言。 */
        function activeLocale() {
          try {
            const snapshot = typeof ctx.locale?.getSnapshot === 'function' ? ctx.locale.getSnapshot() : undefined;
            if (snapshot && typeof snapshot.active === 'string' && snapshot.active !== '') return snapshot.active;
          } catch (_error) {
            /* 语言服务不可用时退回中文。 */
          }
          return 'zh';
        }

        /**
         * 读取 Host 已接受的翻译偏好与请求长度上限。
         * @param force - 为 true 时忽略缓存重新读取。
         * @returns Host 快照。
         */
        async function readMeta(force) {
          if (state.meta !== undefined && force !== true) return state.meta;
          const remote = remoteService();
          if (remote === undefined) throw new Error('cotTranslation remote unavailable (enable the cot-translation bundle)');
          const result = await remote.limits(new AbortController().signal);
          if (!result || result.ok !== true) throw new Error('translation limits unavailable');
          state.meta = result.value;
          return result.value;
        }

        /**
         * 通过 Host 翻译一段预览文本。
         * @param text - 原文。
         * @returns 译文。
         */
        async function requestTranslation(text) {
          const remote = remoteService();
          if (remote === undefined) throw new Error('cotTranslation remote unavailable');
          const sessionId = state.sessionId;
          if (typeof sessionId !== 'string' || sessionId === '') throw new Error('no current session');
          const meta = await readMeta(false);
          const preferences = meta && meta.preferences !== undefined
            ? meta.preferences
            : { provider: 'bing', targetLanguage: 'auto' };
          const targetLanguage = preferences.targetLanguage === 'auto' ? activeLocale() : preferences.targetLanguage;
          const controller = new AbortController();
          const timer = setTimeout(() => { controller.abort(new Error('translation timeout')) }, REQUEST_TIMEOUT_MS);
          try {
            const result = await remote.translate({
              text, provider: preferences.provider, targetLanguage, sessionId,
            }, controller.signal);
            if (typeof result === 'string' && result.trim() !== '') return result;
            if (!result || result.ok !== true) throw new Error('translation failed');
            if (typeof result.value !== 'string' || result.value.trim() === '') throw new Error('empty translation');
            return result.value;
          } finally {
            clearTimeout(timer);
          }
        }

        /**
         * 命中缓存或复用在途请求。
         * @param text - 原文。
         * @returns 译文 Promise。
         */
        function resolveTranslation(text) {
          const cached = state.cache.get(text);
          if (cached !== undefined) return Promise.resolve(cached);
          const running = state.inflight.get(text);
          if (running !== undefined) return running;
          const task = requestTranslation(text).then((value) => {
            if (state.cache.size >= CACHE_LIMIT) {
              const oldest = state.cache.keys().next();
              if (!oldest.done) state.cache.delete(oldest.value);
            }
            state.cache.set(text, value);
            return value;
          }).finally(() => { state.inflight.delete(text) });
          state.inflight.set(text, task);
          return task;
        }

        /** 把译文插到预览容器里，并隐藏原文节点（不删除，React 仍可正常更新它）。 */
        function paint(parts, translated) {
          const { summary, textHost } = parts;
          let own = null;
          for (const child of summary.children) {
            if (child.hasAttribute(OWN_ATTR)) { own = child; break; }
          }
          if (own === null) {
            own = document.createElement('span');
            own.setAttribute(OWN_ATTR, '');
            own.className = textHost.className;
            summary.appendChild(own);
          }
          own.textContent = translated;
          textHost.setAttribute(HIDDEN_ATTR, '');
          state.paintedCount += 1;
        }

        /** 还原一行：移除译文节点，取消隐藏。 */
        function restore(parts) {
          if (parts.textHost.hasAttribute(HIDDEN_ATTR)) parts.textHost.removeAttribute(HIDDEN_ATTR);
          for (const child of Array.from(parts.summary.children)) {
            if (child.hasAttribute(OWN_ATTR)) child.remove();
          }
        }

        /**
         * 把工具折叠行里的英文 wire 工具名换成中文标签。
         *
         * 只动文本节点里的工具名前缀：DSH 对未登记的工具拼出 `toolName · <参数摘要>`，
         * 已知工具（bash/read/grep…）的摘要里没有工具名，因此天然不会被改到。
         * 参数部分（命令、路径、query）一个字符都不改，仍然可复制可直接用。
         * @param row - 带 data-tool 的工具行根节点。
         */
        function rewriteToolSummary(row) {
          if (state.disposed) return;
          const toolName = row.getAttribute('data-tool');
          if (typeof toolName !== 'string' || toolName === '') return;
          const label = toolLabel(toolName);
          if (label === toolName) return;
          const parts = queryParts(row);
          if (parts === null) return;
          const text = readSummary(parts.textHost);
          if (text === '') return;
          const prefix = toolName + ' · ';
          let next;
          if (text === toolName) next = label;
          else if (text.startsWith(prefix)) next = label + ' · ' + text.slice(prefix.length);
          else return;
          const node = summaryTextNode(parts.textHost);
          if (node === null) return;
          if (node.nodeValue === next) return;
          node.nodeValue = next;
          state.rewrittenCount += 1;
        }

        /** 安排一次翻译：等待文本稳定、去重、失败冷却都在这里。 */
        function syncRow(row) {
          if (state.disposed) return;
          if (row.hasAttribute('data-expanded')) return;
          const parts = queryParts(row);
          if (parts === null) return;
          const text = readSummary(parts.textHost);
          if (text === '') { restore(parts); return; }
          if (looksChinese(text)) { restore(parts); return; }
          if (state.painted.get(row) === text) return;
          const cooldownUntil = state.failures.get(text);
          if (cooldownUntil !== undefined) {
            if (Date.now() < cooldownUntil) { restore(parts); return; }
            state.failures.delete(text);
          }
          const previous = state.lastSeen.get(row);
          state.lastSeen.set(row, text);
          const pending = state.timers.get(row);
          if (pending !== undefined) {
            if (previous === text) return;
            clearTimeout(pending);
          }
          const streaming = parts.summary.hasAttribute('data-streaming');
          const timer = setTimeout(() => {
            state.timers.delete(row);
            if (state.disposed || !row.isConnected) return;
            const current = queryParts(row);
            if (current === null || readSummary(current.textHost) !== text) return;
            resolveTranslation(text).then((translated) => {
              if (state.disposed || !row.isConnected) return;
              const fresh = queryParts(row);
              if (fresh === null || readSummary(fresh.textHost) !== text) return;
              paint(fresh, translated);
              state.painted.set(row, text);
            }).catch((error) => {
              state.failures.set(text, Date.now() + RETRY_AFTER_MS);
              state.meta = undefined;
              const reason = error && error.message ? error.message : String(error);
              report('translate-failed: ' + reason, {
                textLength: text.length,
                session: typeof state.sessionId === 'string' && state.sessionId !== '',
              });
            });
          }, streaming ? STREAM_DEBOUNCE_MS : 0);
          state.timers.set(row, timer);
        }

        /** 把一行交给视口观察器，避免为一屏之外的旧思考发请求；在视口内则立即同步。 */
        function observeRow(row) {
          if (!state.observed.has(row)) {
            state.observed.add(row);
            if (intersection !== null) intersection.observe(row);
          }
          if (intersection === null || visible.has(row)) syncRow(row);
        }

        /** 扫描当前文档里的思考行与工具行。 */
        function scan() {
          if (state.disposed) return;
          for (const row of document.querySelectorAll(ROW_SELECTOR)) {
            if (row.hasAttribute('data-expanded')) continue;
            observeRow(row);
          }
          for (const row of document.querySelectorAll(TOOL_ROW_SELECTOR)) {
            rewriteToolSummary(row);
          }
        }

        /** 合并突变后的扫描（节流，避免流式输出期间每帧全量查询）。 */
        function schedule() {
          if (state.disposed || scanTimer !== 0) return;
          scanTimer = setTimeout(() => { scanTimer = 0; scan(); }, SCAN_DEBOUNCE_MS);
        }

        /** 一行都没翻成功时，报告卡在哪一步（健康的页面上不会触发）。 */
        function diagnose() {
          if (state.disposed || state.paintedCount > 0) return;
          const rows = document.querySelectorAll(ROW_SELECTOR);
          let preview = 0;
          for (const row of rows) if (row.hasAttribute('data-preview')) preview += 1;
          report('no-preview-translated', {
            session: typeof state.sessionId === 'string' ? state.sessionId.slice(0, 8) : null,
            remote: remoteService() !== undefined,
            remoteError: remoteAccessError || null,
            rows: rows.length,
            previewRows: preview,
            separators: document.querySelectorAll(SEPARATOR_SELECTOR).length,
          });
        }

        /** 工具行存在且有可用映射、却一行都没改写成功时，报告卡在哪一步。 */
        function diagnoseTools() {
          if (state.disposed || state.rewrittenCount > 0) return;
          const rows = Array.from(document.querySelectorAll(TOOL_ROW_SELECTOR));
          if (rows.length === 0) return;
          let mapped = 0;
          let withSeparator = 0;
          for (const row of rows) {
            const name = row.getAttribute('data-tool');
            if (typeof name === 'string' && toolLabel(name) !== name) mapped += 1;
            if (row.querySelector(SEPARATOR_SELECTOR) !== null) withSeparator += 1;
          }
          if (mapped === 0) return;
          report('no-tool-label-applied', { rows: rows.length, mapped, separators: withSeparator });
        }

        // 仅隐藏原文的样式；译文节点复用原文的类名，因此排版完全一致。
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = '[' + HIDDEN_ATTR + ']{display:none!important}';
        document.head.appendChild(style);

        if (typeof IntersectionObserver === 'function') {
          intersection = new IntersectionObserver((entries) => {
            for (const entry of entries) {
              if (entry.isIntersecting) {
                visible.add(entry.target);
                syncRow(entry.target);
              } else {
                visible.delete(entry.target);
              }
            }
          }, { rootMargin: '200px 0px' });
        }

        // 会话身份来自会话作用域的 composer dock：宿主注入的 sessionId 即当前可见会话。
        function bindSession(sessionId) {
          if (typeof sessionId !== 'string' || sessionId === '') return;
          if (state.sessionId === sessionId) return;
          state.sessionId = sessionId;
        }

        function SessionAnchor(props) {
          bindSession(props && props.sessionId);
          return null;
        }

        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'cot-preview-zh-anchor',
          order: 0,
          inject: (sessionId) => {
            bindSession(sessionId);
            return {};
          },
        }, SessionAnchor));

        const mutation = new MutationObserver((records) => {
          // 忽略我们自己的写入，避免自激循环。
          for (const record of records) {
            if (record.type !== 'childList') continue;
            for (const node of record.addedNodes) {
              if (node.nodeType !== 1) continue;
              if (node.hasAttribute(OWN_ATTR)) return;
            }
          }
          schedule();
        });
        mutation.observe(document.body, {
          childList: true,
          subtree: true,
          characterData: true,
          attributes: true,
          attributeFilter: ['data-preview', 'data-expanded', 'data-streaming'],
        });

        schedule();
        const diagnoseTimers = DIAGNOSE_AT_MS.map((delay) => setTimeout(diagnose, delay))
          .concat(DIAGNOSE_AT_MS.map((delay) => setTimeout(diagnoseTools, delay)));

        ctx.effect(() => () => {
          state.disposed = true;
          mutation.disconnect();
          if (intersection !== null) intersection.disconnect();
          if (scanTimer !== 0) { clearTimeout(scanTimer); scanTimer = 0; }
          for (const timer of diagnoseTimers) clearTimeout(timer);
          for (const timer of state.timers.values()) clearTimeout(timer);
          state.timers.clear();
          state.cache.clear();
          state.inflight.clear();
          state.failures.clear();
          if (style.parentNode !== null) style.parentNode.removeChild(style);
          for (const own of Array.from(document.querySelectorAll('[' + OWN_ATTR + ']'))) own.remove();
          for (const host of Array.from(document.querySelectorAll('[' + HIDDEN_ATTR + ']'))) host.removeAttribute(HIDDEN_ATTR);
        }, 'cot-preview-zh: observers and pending translations');
      },
    };
  },
});
