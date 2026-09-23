import { getSharedSceneService } from './service.js';
import { formatGameTime, formatPeriods, parsePeriods, createSceneId } from './model.js';
import { contextExpiryPreview } from '../effects/model.js';
import { mountTravel, appendExpiryPreview } from './travel-view.js';
const node = (tag, text, className) => { const el = document.createElement(tag); if (text != null) el.textContent = text; if (className) el.className = className; return el; };
const LABELS = { 'set-time': '设置游戏时间', 'advance-time': '推进游戏时间', travel: '旅行', periods: '保存时段划分', 'save-scene': '保存场景资料', 'switch-scene': '进入场景', 'leave-scene': '离开当前场景', settings: '保存读取设置' };
const mountedViews = new WeakMap();
export function mount(target, { service = getSharedSceneService(), travelService, expiryPreview = contextExpiryPreview } = {}) {
    const existing = mountedViews.get(target); if (existing) { existing.open(); return existing; }
    const api = service, instance = 'amin-scene-' + createSceneId();
    const page = node('div', null, 'amin-page amin-app-page amin-scene'), intro = node('div', null, 'amin-context'), tabs = node('nav', null, 'amin-tabs');
    const notice = node('div', null, 'amin-notice'), review = node('section', null, 'amin-stack'), body = node('section', null, 'amin-stack');
    tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', '场景与时间页面');
    notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite');
    body.id = instance + '-body'; body.setAttribute('role', 'tabpanel'); page.append(intro, tabs, notice, review, body); target.append(page);
    const travelHost = node('div', null, 'amin-stack'), travelView = mountTravel(travelHost, { service: travelService, periods: () => api.read().periods });
    let tab = '时钟', token = null, selected = '', clockDraft = null, sceneDraft = null, periodsDraft = '', settingDraft = null, disposed = false;
    let timeReason = '', sceneReason = '', advanceReason = '', amount = 10, unit = 'minutes', message = '', error = false;
    const say = (value, failed = false) => { message = value; error = failed; notice.textContent = value; notice.dataset.state = failed ? 'error' : api.busy() ? 'busy' : ''; };
    const action = fn => async () => { try { error = false; await fn(); } catch (e) { say(e.message, true); } };
    const button = (label, fn, primary = false) => { const b = node('button', label, primary ? 'amin-primary' : ''); b.type = 'button'; b.disabled = api.busy(); b.addEventListener('click', action(fn)); return b; };
    function field(label, value, onChange, { type = 'text', multi = false, full = false, min, max, help } = {}) {
        const wrap = node('label', null, 'amin-field' + (full ? ' amin-span-full' : ''));
        const control = node(multi ? 'textarea' : 'input'); control.value = value ?? ''; if (!multi) control.type = type;
        if (min != null) control.min = min; if (max != null) control.max = max;
        control.addEventListener('input', () => onChange(type === 'number' ? (control.value === '' ? NaN : Number(control.value)) : control.value));
        wrap.append(node('span', label), control); if (help) wrap.append(node('small', help)); return wrap;
    }
    function check(label, value, onChange) {
        const wrap = node('label', null, 'amin-check'), input = node('input'); input.type = 'checkbox'; input.checked = !!value;
        input.addEventListener('change', () => onChange(input.checked)); wrap.append(input, node('span', label)); return wrap;
    }
    const card = title => { const out = node('section', null, 'amin-card amin-stack'); if (title) out.append(node('h3', title)); return out; };
    function loadScene(state) {
        const scene = state.scenes[selected];
        sceneDraft = scene ? structuredClone(scene) : { name: '', participants: '', weather: '', objects: '', notes: '', mapId: '', nodeId: '' };
        sceneReason = scene ? '更新场景资料' : '建立场景资料';
    }
    function resetDrafts(state, moved) {
        if (moved) { selected = state.activeSceneId ?? ''; message = ''; error = false; advanceReason = ''; amount = 10; unit = 'minutes'; }
        if (selected && !state.scenes[selected]) selected = '';
        clockDraft = structuredClone(state.clock ?? { year: 1, month: 1, day: 1, hour: 8, minute: 0, calendarLabel: '' });
        periodsDraft = formatPeriods(state.periods); settingDraft = { ...state.settings }; loadScene(state);
        timeReason = state.clock ? '校正游戏时间' : '设置故事起始时间';
    }
    function stage(op, data) { api.stage(op, data, token); }
    function renderReview(state) {
        review.replaceChildren(); const draft = api.preview();
        if (!draft) return;
        const panel = card('待确认 · ' + LABELS[draft.op]); panel.classList.add('amin-result');
        panel.append(node('p', '原因：' + draft.reason));
        if (['set-time', 'advance-time'].includes(draft.op)) {
            panel.append(node('p', formatGameTime(draft.details.beforeTime, state.periods) + ' → ' + formatGameTime(draft.details.afterTime, draft.state.periods)));
            if (draft.op === 'advance-time') {
                try { appendExpiryPreview(panel, expiryPreview(api.context(), draft.details.afterTime).newlyExpired); }
                catch (e) { panel.append(node('p', '无法检查限时效果：' + e.message, 'amin-notice')); }
            }
        }
        if (draft.op === 'periods') panel.append(node('pre', formatPeriods(draft.state.periods)));
        if (draft.op === 'settings') panel.append(node('p', `应用${draft.state.settings.enabled ? '启用' : '停用'}；正文和工具 AI ${draft.state.settings.includeInContext ? '读取已确认场景' : '不读取场景'}。`));
        if (draft.op === 'leave-scene') panel.append(node('p', '清除当前场景选择，游戏时间与已存场景保留。'));
        if (['save-scene', 'switch-scene'].includes(draft.op)) {
            const candidate = draft.state.scenes[draft.details.sceneId];
            if (candidate) panel.append(sceneSummary(candidate, draft.state.periods));
            if (draft.op === 'switch-scene') panel.append(node('p', '进入后沿用上面已保存的资料；游戏时钟保持 ' + formatGameTime(draft.state.clock, draft.state.periods) + '。', 'amin-meta'));
        }
        const actions = node('div', null, 'amin-toolbar'); actions.append(button('确认应用一次', () => api.confirm(), true), button('取消', () => api.discard())); panel.append(actions); review.append(panel);
    }
    function sceneSummary(scene, periods) {
        const result = node('div', null, 'amin-stack'); result.append(node('strong', scene.name));
        for (const [key, label] of Object.entries({ participants: '在场人物', weather: '天气与环境', objects: '场景物件', notes: '已确认资料' })) if (scene[key]) result.append(node('p', label + '：' + scene[key]));
        if (scene.mapId) result.append(node('p', `地图 ${scene.mapId}${scene.nodeId ? ' / 地点 ' + scene.nodeId : ''}`, 'amin-meta'));
        result.append(node('p', '资料确认时刻：' + formatGameTime(scene.gameTime, periods), 'amin-meta')); return result;
    }
    function renderClock(state) {
        const current = card('当前游戏时间'); current.append(node('strong', formatGameTime(state.clock, state.periods)), node('p', '游戏时间由你确认推进。重新生成、续写或切换 AI 回复不会自动增加时间。', 'amin-meta')); body.append(current);
        const advance = card('推进与休息'), form = node('div', null, 'amin-form-grid');
        form.append(field('推进量', amount, value => { amount = value; }, { type: 'number', min: 1 }), field('原因', advanceReason, value => { advanceReason = value; }, { help: '例如调查房间、赶路或休息。' }));
        const selectWrap = node('label', null, 'amin-field'), select = node('select'); selectWrap.append(node('span', '单位'), select);
        for (const [value, label] of [['minutes', '分钟'], ['hours', '小时']]) { const option = node('option', label); option.value = value; select.append(option); }
        select.value = unit; select.addEventListener('change', () => { unit = select.value; }); form.prepend(selectWrap); advance.append(form);
        const actions = node('div', null, 'amin-toolbar');
        const previewAdvance = (minutes, reason) => stage('advance-time', { minutes, reason });
        for (const [label, minutes] of [['10 分钟', 10], ['1 小时', 60], ['短休 · 1 小时', 60], ['长休 · 8 小时', 480]]) {
            const b = button(label, () => previewAdvance(minutes, advanceReason.trim() || label)); b.disabled ||= !state.clock; actions.append(b);
        }
        const custom = button('预览自定义推进', () => previewAdvance(amount * (unit === 'hours' ? 60 : 1), advanceReason), true); custom.disabled ||= !state.clock; actions.append(custom); advance.append(actions, node('p', '休息按钮只推进游戏时钟；生命、资源与状态效果由对应应用管理。', 'amin-meta')); body.append(advance);
        const editor = card(state.clock ? '校正日期与时间' : '设置故事起始时间'), grid = node('div', null, 'amin-form-grid');
        grid.append(field('历法名称（可选）', clockDraft.calendarLabel, value => { clockDraft.calendarLabel = value; }, { full: true, help: '可写帝国历、调查日历等名称；日期仍采用公历月长与闰年规则。' }));
        for (const [key, label, min, max] of [['year', '年', 1, 9999], ['month', '月', 1, 12], ['day', '日', 1, 31], ['hour', '时', 0, 23], ['minute', '分', 0, 59]]) grid.append(field(label, clockDraft[key], value => { clockDraft[key] = value; }, { type: 'number', min, max }));
        grid.append(field('设置原因', timeReason, value => { timeReason = value; }, { full: true })); editor.append(grid, button('预览时间设置', () => stage('set-time', { clock: clockDraft, reason: timeReason }))); body.append(editor);
    }
    function renderScenes(state) {
        const current = card('当前场景'), active = state.scenes[state.activeSceneId];
        if (active) { current.append(sceneSummary(active, state.periods)); current.append(button('预览离开场景', () => stage('leave-scene', { reason: '离开当前场景' }))); }
        else current.append(node('p', '尚未选择当前场景。保存资料后，明确进入场景才会作为当前上下文。', 'amin-empty'));
        body.append(current);
        const editor = card('场景资料'), choose = node('label', null, 'amin-field'), picker = node('select'); choose.append(node('span', '选择已存场景或新建'), picker);
        const blank = node('option', '＋ 新建场景'); blank.value = ''; picker.append(blank);
        for (const scene of Object.values(state.scenes)) { const option = node('option', scene.name + (scene.id === state.activeSceneId ? ' · 当前' : '')); option.value = scene.id; picker.append(option); }
        picker.value = selected; picker.addEventListener('change', () => { selected = picker.value; loadScene(api.read()); render(); }); editor.append(choose);
        if (selected) editor.append(button('预览进入并沿用已存资料', () => stage('switch-scene', { sceneId: selected, reason: '进入场景：' + state.scenes[selected].name }), true));
        const form = node('div', null, 'amin-form-grid');
        form.append(field('场景名称', sceneDraft.name, value => { sceneDraft.name = value; }, { full: true }));
        for (const [key, label] of [['participants', '在场人物'], ['weather', '天气与环境'], ['objects', '场景物件'], ['notes', '其他已确认资料']]) form.append(field(label, sceneDraft[key], value => { sceneDraft[key] = value; }, { multi: true, help: key === 'objects' ? '记录摆设、门窗等场景事实；随身物品由背包管理。' : '留空表示未知。' }));
        form.append(field('地图 ID（可选）', sceneDraft.mapId, value => { sceneDraft.mapId = value; }), field('地点 ID（可选）', sceneDraft.nodeId, value => { sceneDraft.nodeId = value; }));
        const references = api.mapReferences(), location = references.find(ref => ref.current);
        const links = node('div', null, 'amin-toolbar amin-span-full');
        const useCurrent = button('引用地图当前位置', () => { if (!location) throw Error('当前地图没有已发现的当前位置。'); sceneDraft.mapId = location.mapId; sceneDraft.nodeId = location.nodeId; render(); }); useCurrent.disabled ||= !location; links.append(useCurrent, button('清除地图引用', () => { sceneDraft.mapId = ''; sceneDraft.nodeId = ''; render(); })); form.append(links);
        if (location) form.append(node('p', '地图当前位置：' + location.mapName + ' / ' + location.nodeName, 'amin-meta amin-span-full'));
        form.append(field('保存原因', sceneReason, value => { sceneReason = value; }, { full: true }));
        editor.append(form, node('p', '切换场景恢复该处保存的资料，并保留全局游戏时间。地图关联仅作引用。', 'amin-meta'));
        const actions = node('div', null, 'amin-toolbar'); actions.append(button('预览保存资料', () => stage('save-scene', { scene: sceneDraft, reason: sceneReason }), true), button('预览保存并进入', () => stage('save-scene', { scene: sceneDraft, reason: sceneReason, activate: true })));
        editor.append(actions); body.append(editor);
    }
    function renderHistory(state) {
        body.append(node('p', '这里只展示属于当前聊天消息与回复候选路径的已确认记录。回到旧分支时，后续记录不会成为当前事实。', 'amin-context'));
        const entries = api.history().slice().reverse();
        if (!entries.length) { body.append(node('p', '还没有已确认操作。', 'amin-empty')); return; }
        for (const event of entries.slice(0, 100)) {
            const entry = card(LABELS[event.op] ?? event.op); entry.append(node('p', event.reason), node('p', `${event.floor ? '第 ' + event.floor + ' 条消息之后' : '聊天开始前'} · ${event.at}`, 'amin-meta'));
            if (['set-time', 'advance-time', 'travel'].includes(event.op)) entry.append(node('p', formatGameTime(event.details.beforeTime, state.periods) + ' → ' + formatGameTime(event.details.afterTime, state.periods)));
            if (event.details.sceneName) entry.append(node('p', event.details.sceneName)); body.append(entry);
        }
        if (entries.length > 100) body.append(node('p', `显示最近 100 条；当前分支共 ${entries.length} 条记录，早期记录仍用于恢复。`, 'amin-meta'));
    }
    function renderSettings() {
        const settings = card('上下文读取'); settings.append(check('启用场景与时间上下文', settingDraft.enabled, value => { settingDraft.enabled = value; }), check('允许正文与应用 AI 读取当前已确认资料', settingDraft.includeInContext, value => { settingDraft.includeInContext = value; }), node('p', '默认不注入。开启后只读取当前游戏时间与已进入场景的已存字段。草稿、其他场景和历史分支不会注入。', 'amin-meta'), button('预览保存读取设置', () => stage('settings', { ...settingDraft, reason: '调整场景上下文读取设置' })));
        const periods = card('每日时段'); periods.append(field('时段开始时间与名称', periodsDraft, value => { periodsDraft = value; }, { multi: true, help: '每行一项，格式 HH:MM 名称；必须包含 00:00。时段只影响显示，不自动产生天气或人物活动。' }), button('预览保存时段', () => stage('periods', { periods: parsePeriods(periodsDraft), reason: '调整每日时段划分' }))); body.append(settings, periods);
    }
    function render() {
        if (disposed) return;
        let state, currentToken;
        try { currentToken = api.capture(); state = api.read(); } catch (e) { body.replaceChildren(node('p', e.message, 'amin-empty')); review.replaceChildren(); intro.textContent = '场景与时间 · 当前聊天'; return; }
        const moved = !token || token.identity !== currentToken.identity || token.metadata !== currentToken.metadata || token.path !== currentToken.path;
        if (moved || token.basis !== currentToken.basis) resetDrafts(state, moved);
        token = currentToken;
        intro.textContent = `场景与时间 · ${formatGameTime(state.clock, state.periods)} · ${state.scenes[state.activeSceneId]?.name ?? '未进入场景'} · ${state.settings.enabled && state.settings.includeInContext ? '已开启 AI 读取' : '仅本地记录'}`;
        tabs.replaceChildren();
        const names = ['时钟', '场景', '旅行', '记录', '设置'];
        for (const name of names) {
            const b = button(name, () => { tab = name; render(); }); b.id = instance + '-' + name; b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', String(tab === name)); b.setAttribute('aria-controls', body.id); b.tabIndex = tab === name ? 0 : -1;
            b.addEventListener('keydown', e => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return; e.preventDefault(); tab = e.key === 'Home' ? names[0] : e.key === 'End' ? names.at(-1) : names[(names.indexOf(tab) + (e.key === 'ArrowRight' ? 1 : names.length - 1)) % names.length]; render(); tabs.querySelector('[aria-selected="true"]')?.focus(); });
            tabs.append(b);
        }
        body.setAttribute('aria-labelledby', instance + '-' + tab);
        body.replaceChildren(); renderReview(state);
        if (tab === '时钟') renderClock(state); else if (tab === '场景') renderScenes(state); else if (tab === '旅行') { body.append(travelHost); travelView.open(); } else if (tab === '记录') renderHistory(state); else renderSettings();
        say(error ? message : api.status(), error);
        if (api.dirty()) { const retry = card('保存尚未完成'); retry.append(node('p', '已确认操作保留在当前聊天内存中。重试保存会沿用同一条记录。'), button('重试保存', () => api.retrySave(), true)); body.prepend(retry); }
    }
    const unsubscribe = api.subscribe(render); render();
    const view = {
        open() { if (disposed) return; api.sync(); render(); },
        dispose() { if (disposed) return; disposed = true; unsubscribe(); travelView.dispose(); page.remove(); if (mountedViews.get(target) === view) mountedViews.delete(target); },
    };
    mountedViews.set(target, view); return view;
}
