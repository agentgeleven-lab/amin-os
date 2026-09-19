import { getAI } from '../../ai/service.js';
import { getSharedFactions } from './service.js';
import { createCampaign, createFaction, createRegion, territoryCount } from './model.js';
import { normalizeRules, applyUpdate, tickPeace, describeDelta, TYPE_LABELS, INTENSITIES, BATTLE_TYPES, CAUSES, CAUSE_LABELS } from './rules.js';
import { templateList, template } from './templates.js';
import { requestFactions, parseBoard, parseReview, proposalsToUpdate } from './ai.js';

const el = (tag, text, cls) => { const e = document.createElement(tag); if (text != null && text !== '') e.textContent = text; if (cls) e.className = cls; return e; };
const INTENSITY_NAMES = { light: '轻', medium: '中', severe: '惨烈' };
const BATTLE_NAMES = { skirmish: '遭遇战', field: '野战', siege: '围攻', subterfuge: '渗透暗战', diplomacy: '外交斡旋', other: '其他冲突' };

// 模块级单例：同一时刻最多一个挂载实例，重复 mount 先拆旧实例（DOM + 监听），防叠加。
let activeView = null;
export function mount(target) {
    activeView?.dispose?.();
    const api = getSharedFactions();
    const page = el('div', null, 'amin-page amin-factions'), context = el('div', null, 'amin-context');
    const tabs = el('div', null, 'amin-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', '势力沙盘页面');
    const status = el('div', null, 'amin-notice'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const body = el('section'); body.setAttribute('role', 'tabpanel');
    page.append(context, tabs, status, body); target.append(page);
    let selected = '势力榜', preview = null, wizard = false, wizardScale = 'street', running = null, seenPending = false;
    const say = text => { status.textContent = text; };
    const bar = (value, max, color) => { const wrap = el('div', null, 'amin-fx-bar'); const fill = el('span'); fill.style.width = Math.max(0, Math.min(100, (value / (max || 100)) * 100)) + '%'; if (color) fill.style.background = color; wrap.append(fill); wrap.title = String(value); return wrap; };
    const COLORS = ['#5aa5a0', '#a5645a', '#7d5aa5', '#5a8fa5', '#a58f5a', '#6fae57', '#b25f8f', '#8a8f5a'];
    const ideaStrip = ideologies => {
        const list = (ideologies ?? []).filter(i => i?.name);
        const total = list.reduce((sum, i) => sum + Math.max(0, i.weight), 0);
        if (!total) return null;
        const strip = el('div', null, 'amin-fx-ideas'); strip.title = list.map(i => i.name + ' ' + Math.round((i.weight / total) * 100) + '%').join(' · ');
        list.forEach((i, index) => { const part = el('span'); part.style.flexGrow = String(Math.max(1, Math.round(i.weight))); part.style.background = COLORS[index % COLORS.length]; strip.append(part); });
        return strip;
    };
    function button(parent, label, fn, primary = false) { const b = el('button', label, primary ? 'amin-primary' : ''); b.type = 'button'; b.onclick = async () => { b.disabled = true; try { await fn(); } catch (e) { say(e.message); } finally { b.disabled = false; } }; parent.append(b); return b; }
    function field(parent, label, value = '', multiline = false) { const row = el('label', label); const input = el(multiline ? 'textarea' : 'input'); input.value = String(value ?? ''); input.setAttribute('aria-label', label); if (multiline) input.rows = 3; row.append(input); parent.append(row); return input; }
    function numberField(parent, label, value, attrs = {}) { const input = field(parent, label, value); input.type = 'number'; for (const [k, v] of Object.entries(attrs)) input[k] = v; return input; }
    function select(parent, label, options, value) { const row = el('label', label); const input = el('select'); input.setAttribute('aria-label', label); for (const [v, text] of options) { const o = el('option', text); o.value = v; input.append(o); } if (value !== undefined && [...input.options].some(o => o.value === value)) input.value = value; row.append(input); parent.append(row); return input; }
    const card = title => { const c = el('section', null, 'amin-card'); if (title) c.append(el('h3', title)); body.append(c); return c; };
    const finish = text => { preview = null; render(); say(text); };

    const current = () => { try { return api.active(); } catch { return null; } };
    function drawContext() {
        context.replaceChildren();
        let snap = null;
        try { snap = api.snapshot(); } catch (e) { context.append(el('span', e.message)); return false; }
        const picker = el('select'); picker.setAttribute('aria-label', '选择棋局');
        if (!snap.names.length) picker.append(el('option', '还没有棋局'));
        else for (const item of snap.names) { const o = el('option', item.name); o.value = item.id; if (item.id === snap.activeId) o.selected = true; picker.append(o); }
        picker.onchange = () => { try { api.setActive(picker.value); render(); } catch (e) { say(e.message); } };
        context.append(picker, el('button', '新建棋局'));
        context.lastChild.type = 'button'; context.lastChild.onclick = () => { wizard = true; preview = null; render(); };
        const review = el('button', '剧情盘点'), regen = el('button', '全量重生成');
        review.type = regen.type = 'button'; review.disabled = regen.disabled = !snap.names.length;
        review.onclick = () => runAI('review'); regen.onclick = () => runAI('regenerate');
        context.append(review, regen);
        return true;
    }

    function drawPendingNotice() {
        if (!api.pending()) return;
        const note = el('section', null, 'amin-card amin-fx-preview');
        note.append(el('h3', 'AI 回复包含势力变更'), el('p', '来自增量跟随的隐藏块，确认前不会写入沙盘。'));
        const toolbar = el('div', null, 'amin-toolbar'); note.append(toolbar);
        button(toolbar, '查看变更', () => { const result = api.previewPending(); if (!result) { render(); return; } showApplyPreview('增量跟随', result); }, true);
        button(toolbar, '忽略', () => { api.dropPending(); render(); });
        body.append(note);
    }

    function showApplyPreview(title, result, note = '') {
        preview = {
            title, note, events: result.events, rejected: result.rejected,
            confirm: async () => { api.saveCampaign(result.campaign); },
        };
        render();
    }

    function drawPreview() {
        const c = card('变更预览 · ' + preview.title);
        if (preview.note) c.append(el('p', preview.note));
        if (!preview.events.length) c.append(el('p', '没有产生任何数值变更。'));
        const list = el('ol', null, 'amin-fx-time');
        for (const e of preview.events) {
            const item = el('li');
            item.append(el('strong', TYPE_LABELS[e.type] ?? e.type));
            if (e.description) item.append(el('p', e.description));
            const delta = describeDelta(e.deltas); if (delta) item.append(el('p', delta, 'amin-fx-delta'));
            list.append(item);
        }
        c.append(list);
        if (preview.rejected?.length) c.append(el('p', '未识别条目（已忽略）：' + preview.rejected.map(r => r.ref || r.kind).join('、')));
        const toolbar = el('div', null, 'amin-toolbar'); c.append(toolbar);
        button(toolbar, '确认应用', async () => { await preview.confirm(); finish('变更已写入沙盘'); }, true);
        button(toolbar, '放弃变更', () => finish('已放弃本次变更'));
    }

    function drawBoardPreview(campaign, note) {
        const c = card('变更预览 · ' + (campaign.history.at(-1)?.type === 'regenerate' ? '全量重生成' : 'AI 建盘'));
        c.append(el('p', note || campaign.name), el('p', campaign.factions.length + ' 个势力 · ' + campaign.regions.length + ' 个地区 · ' + template(campaign.scaleTemplate)?.name));
        c.append(el('p', '势力：' + campaign.factions.map(f => f.name + '（' + campaign.regions.filter(r => r.controller === f.id).length + ' 块地盘）').join('、')));
        const detail = el('details'); detail.append(el('summary', '查看完整沙盘 JSON'));
        const pre = el('pre'); pre.textContent = JSON.stringify({ factions: campaign.factions, regions: campaign.regions }, null, 1); detail.append(pre); c.append(detail);
        const toolbar = el('div', null, 'amin-toolbar'); c.append(toolbar);
        button(toolbar, '确认替换', async () => { api.saveCampaign(campaign); finish('沙盘已写入'); }, true);
        button(toolbar, '放弃', () => finish('已放弃本次结果'));
    }

    function drawWizard() {
        const c = card('创建势力沙盘棋局');
        c.append(el('p', '选择规模模板决定指标集、地区命名习惯与人口量级；规则系数之后随时可调。'));
        const grid = el('div', null, 'amin-fx-grid'); c.append(grid);
        for (const tpl of templateList()) {
            const item = el('button', null, 'amin-fx-region' + (wizardScale === tpl.id ? ' amin-fx-selected' : '')); item.type = 'button';
            item.append(el('h4', tpl.name), el('p', tpl.blurb, 'amin-fx-delta'));
            item.append(el('p', '指标：' + tpl.metrics.map(m => m.label).join(' / ')));
            item.append(el('p', '地区习惯：' + tpl.regionNouns.slice(0, 3).join('、') + ' ｜ 人口：' + tpl.population.min + '–' + tpl.population.max + tpl.population.unit));
            item.onclick = () => { wizardScale = tpl.id; render(); };
            grid.append(item);
        }
        const name = field(c, '棋局名称', template(wizardScale)?.name + '棋局');
        const extra = field(c, '给 AI 的补充要求（可选，用于 AI 生成）', '', true);
        const toolbar = el('div', null, 'amin-toolbar'); c.append(toolbar);
        button(toolbar, 'AI 生成棋盘', () => runAI('board', { scaleTemplate: wizardScale, name: name.value, extra: extra.value }), true);
        button(toolbar, '创建空白棋局', () => { api.saveCampaign(createCampaign({ scaleTemplate: wizardScale, name: name.value })); wizard = false; render(); say('已创建空白棋局，可手动添加势力与地区'); });
        if (current()) button(toolbar, '取消', () => { wizard = false; render(); });
    }

    function drawFactions(c) {
        const toolbar = el('div', null, 'amin-toolbar'); body.append(toolbar);
        button(toolbar, '新建势力', () => factionForm(null), true);
        for (const f of c.factions) {
            const cardEl = el('section', null, 'amin-card amin-fx-card'); cardEl.style.setProperty('--fx', f.color || '#888');
            const head = el('header'); head.append(el('span', f.icon || '✦', 'amin-fx-icon'), el('h3', f.name));
            cardEl.append(head);
            if (f.motto) cardEl.append(el('p', f.motto, 'amin-fx-delta'));
            for (const m of f.metrics) { const row = el('div', null, 'amin-fx-metric'); row.append(el('span', m.label), bar(m.value, m.max, f.color)); cardEl.append(row); }
            const ideas = ideaStrip(f.ideologies);
            if (ideas) { const row = el('div', null, 'amin-fx-metric'); row.append(el('span', '思潮'), ideas); cardEl.append(row); }
            if (f.traits?.length) cardEl.append(el('p', '特质：' + f.traits.join('、'), 'amin-fx-delta'));
            const peers = c.factions.filter(x => x.id !== f.id).map(x => x.name + ' ' + (f.relations[x.id] ?? 0)).join(' ｜ ');
            cardEl.append(el('p', '地盘 ' + territoryCount(c, f.id) + ' 块' + (peers ? ' ｜ 关系：' + peers : ''), 'amin-fx-delta'));
            const tools = el('div', null, 'amin-toolbar'); cardEl.append(tools);
            button(tools, '编辑', () => factionForm(f));
            body.append(cardEl);
        }
        if (!c.factions.length) body.append(el('p', '还没有势力。手动新建，或用顶部按钮让 AI 盘点 / 重建。'));
    }

    function factionForm(existing) {
        const c = current();
        body.replaceChildren();
        const form = card(existing ? '编辑势力 · ' + existing.name : '新建势力');
        const name = field(form, '名称', existing?.name ?? '');
        const fallbackColor = template(c?.scaleTemplate)?.colors?.[c.factions.length % (template(c?.scaleTemplate)?.colors?.length ?? 1)] ?? '#888888';
        const color = field(form, '颜色（#rrggbb）', existing?.color ?? fallbackColor);
        const icon = field(form, '图标（文字或符号，可空）', existing?.icon ?? ''); icon.maxLength = 12;
        const motto = field(form, '口号（可空）', existing?.motto ?? '');
        const metricInputs = {};
        for (const m of existing?.metrics ?? []) metricInputs[m.key] = numberField(form, m.label + '（0–' + m.max + '）', m.value, { min: 0, max: m.max });
        const ideologies = field(form, '思潮（每行一条：名称:权重）', (existing?.ideologies ?? []).map(i => i.name + ':' + i.weight).join('\n'), true);
        const traits = field(form, '特质（逗号分隔，可空）', (existing?.traits ?? []).join('、'));
        const relationInputs = {};
        for (const other of c.factions.filter(x => x.id !== existing?.id)) relationInputs[other.id] = numberField(form, '与「' + other.name + '」关系（-100–100）', existing?.relations?.[other.id] ?? 0, { min: -100, max: 100 });
        const toolbar = el('div', null, 'amin-toolbar'); form.append(toolbar);
        button(toolbar, '保存', () => {
            const label = name.value.trim(); if (!label) throw Error('请填写势力名称');
            if (c.factions.some(f => f.name === label && f.id !== existing?.id)) throw Error('已存在同名势力');
            const next = structuredClone(c);
            const faction = existing ? next.factions.find(f => f.id === existing.id) : createFaction(next, { name: label });
            if (!existing) next.factions.push(faction);
            faction.name = label; faction.color = /^#[0-9a-f]{6}$/i.test(color.value.trim()) ? color.value.trim() : faction.color;
            faction.icon = icon.value.trim().slice(0, 12); faction.motto = motto.value.trim().slice(0, 120);
            for (const [key, input] of Object.entries(metricInputs)) { const m = faction.metrics.find(x => x.key === key); if (m) m.value = Math.max(0, Math.min(m.max ?? 100, Math.round(Number(input.value) || 0))); }
            faction.ideologies = ideologies.value.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => { const [n, w] = line.split(/[:：]/); return { name: (n ?? '').trim().slice(0, 40), weight: Math.max(0, Math.min(100, Math.round(Number(w) || 0))) }; }).filter(i => i.name);
            faction.traits = traits.value.split(/[,，、\n]/).map(t => t.trim()).filter(Boolean);
            for (const [id, input] of Object.entries(relationInputs)) { const value = Math.max(-100, Math.min(100, Math.round(Number(input.value) || 0))); faction.relations[id] = value; const other = next.factions.find(f => f.id === id); if (other) other.relations[faction.id] = value; }
            next.history.push({ ts: new Date().toISOString(), type: 'edit', description: (existing ? '手动编辑势力 ' : '新建势力 ') + label, deltas: {} });
            api.saveCampaign(next); render(); say('已保存');
        }, true);
        button(toolbar, '取消', () => render());
    }

    function drawRegions(c) {
        const toolbar = el('div', null, 'amin-toolbar'); body.append(toolbar);
        button(toolbar, '新建地区', () => regionForm(null), true);
        button(toolbar, '休养生息', () => { const result = tickPeace(current()); if (!result.events.length) { say('各地状况良好，没有需要恢复的地区'); return; } api.saveCampaign(result.campaign); render(); say('休养生息已结算'); });
        const grid = el('div', null, 'amin-fx-grid'); body.append(grid);
        for (const r of c.regions) {
            const faction = c.factions.find(f => f.id === r.controller);
            const item = el('div', null, 'amin-fx-region'); item.style.borderTopColor = faction?.color ?? 'var(--amin-line)';
            const head = el('header'); head.append(el('strong', r.name), el('span', faction?.name ?? '无主', 'amin-fx-owner'));
            item.append(head);
            const unit = template(c.scaleTemplate)?.population?.unit ?? '';
            item.append(el('p', '人口 ' + r.population + (unit ? ' ' + unit : '') + ' ｜ 状况 ' + r.condition, 'amin-fx-delta'));
            item.append(bar(r.condition, 100, faction?.color));
            if (r.statusTags.length) { const tags = el('p'); for (const t of r.statusTags) tags.append(el('span', t, 'amin-fx-tag')); item.append(tags); }
            const tools = el('div', null, 'amin-toolbar'); item.append(tools);
            button(tools, '版图变更', () => battleForm(r));
            button(tools, '编辑', () => regionForm(r));
            grid.append(item);
        }
        if (!c.regions.length) body.append(el('p', '还没有地区。'));
    }

    function battleForm(region) {
        const c = current();
        body.replaceChildren();
        const form = card('版图变更 / 动态结算 · ' + region.name);
        form.append(el('p', '选择新归属与变更方式；征服类变更按烈度结算人口与状况，其余方式只变更归属。'));
        const to = select(form, '新归属势力', [...c.factions.map(f => [f.id, f.name]), ['', '无主']], region.controller ?? '');
        const cause = select(form, '变更方式', CAUSES.map(x => [x, CAUSE_LABELS[x]]), 'conquest');
        const intensity = select(form, '征服烈度', INTENSITIES.map(i => [i, INTENSITY_NAMES[i]]));
        const battleType = select(form, '征服类型', BATTLE_TYPES.map(t => [t, BATTLE_NAMES[t]]));
        const sync = () => { const war = cause.value === 'conquest'; intensity.closest('label').hidden = !war; battleType.closest('label').hidden = !war; };
        cause.onchange = sync; sync();
        const note = field(form, '事件备注（可空）', '');
        const toolbar = el('div', null, 'amin-toolbar'); form.append(toolbar);
        button(toolbar, '结算并保存', () => {
            const patch = { region: region.name, to: to.value || '无主', cause: cause.value, note: note.value.trim() };
            if (cause.value === 'conquest') { patch.intensity = intensity.value; patch.battleType = battleType.value; }
            const result = applyUpdate(c, { transfers: [patch] });
            const miss = result.rejected.filter(r => r.kind === '地区' || r.kind === '势力');
            api.saveCampaign(result.campaign); render();
            say('已结算' + (miss.length ? '；未识别：' + miss.map(r => r.ref).join('、') : ''));
        }, true);
        button(toolbar, '取消', () => render());
    }

    function regionForm(existing) {
        const c = current();
        body.replaceChildren();
        const form = card(existing ? '编辑地区 · ' + existing.name : '新建地区');
        const name = field(form, '名称（可用模板习惯：' + (template(c.scaleTemplate)?.regionNouns ?? []).join('、') + '）', existing?.name ?? '');
        const controller = select(form, '归属势力', [...c.factions.map(f => [f.id, f.name]), ['', '无主']], existing?.controller ?? '');
        const pop = template(c.scaleTemplate)?.population;
        const population = numberField(form, '人口（' + (pop?.min ?? 0) + '–' + (pop?.max ?? 100) + pop?.unit + '）', existing?.population ?? Math.round(((pop?.min ?? 10) + (pop?.max ?? 100)) / 2), { min: 0 });
        const condition = numberField(form, '状况（0–100）', existing?.condition ?? 70, { min: 0, max: 100 });
        const tags = field(form, '状况标签（逗号分隔，如：荒芜、瘟疫）', (existing?.statusTags ?? []).join('、'));
        const toolbar = el('div', null, 'amin-toolbar'); form.append(toolbar);
        button(toolbar, '保存', () => {
            const label = name.value.trim(); if (!label) throw Error('请填写地区名称');
            if (c.regions.some(r => r.name === label && r.id !== existing?.id)) throw Error('已存在同名地区');
            const next = structuredClone(c);
            const region = existing ? next.regions.find(r => r.id === existing.id) : createRegion(next, { name: label });
            if (!existing) next.regions.push(region);
            region.name = label; region.controller = controller.value || null;
            region.population = Math.max(0, Math.round(Number(population.value) || 0));
            region.condition = Math.max(0, Math.min(100, Math.round(Number(condition.value) || 0)));
            region.statusTags = tags.value.split(/[,，、\n]/).map(t => t.trim()).filter(Boolean);
            next.history.push({ ts: new Date().toISOString(), type: 'edit', description: (existing ? '手动编辑地区 ' : '新建地区 ') + label, deltas: {} });
            api.saveCampaign(next); render(); say('已保存');
        }, true);
        button(toolbar, '取消', () => render());
    }

    function drawHistory(c) {
        if (!c.history.length) { body.append(el('p', '还没有纪事。版图变更、动态结算、盘点确认后都会记录在这里。')); return; }
        const list = el('ol', null, 'amin-fx-time'); body.append(list);
        for (const e of [...c.history].reverse()) {
            const item = el('li');
            const head = el('strong', TYPE_LABELS[e.type] ?? e.type);
            if (e.ts) head.append(el('span', ' · ' + new Date(e.ts).toLocaleString(), 'amin-fx-delta'));
            item.append(head);
            if (e.description) item.append(el('p', e.description));
            const delta = describeDelta(e.deltas); if (delta) item.append(el('p', delta, 'amin-fx-delta'));
            list.append(item);
        }
    }

    function drawSettings(c) {
        const form = card('棋局参数 · ' + c.name);
        const tpl = template(c.scaleTemplate);
        form.append(el('p', '模板：' + tpl?.name + '（' + tpl?.blurb + '）。征服结算系数即时生效，已保存的纪事不变；非征服变更不使用这些系数。'));
        const rules = normalizeRules(c.rulesConfig);
        const inputs = {};
        for (const i of INTENSITIES) inputs['intensity.' + i] = numberField(form, '征服烈度 · ' + INTENSITY_NAMES[i] + '（战乱人口损失比例 0–1）', rules.intensity[i], { min: 0, max: 1, step: 0.01 });
        for (const t of BATTLE_TYPES) inputs['battleType.' + t] = numberField(form, '征服类型系数 · ' + BATTLE_NAMES[t] + '（0–3）', rules.battleType[t], { min: 0, max: 3, step: 0.05 });
        for (const i of INTENSITIES) inputs['conditionLoss.' + i] = numberField(form, '征服状况扣减 · ' + INTENSITY_NAMES[i] + '（0–100）', rules.conditionLoss[i], { min: 0, max: 100 });
        inputs.desolationThreshold = numberField(form, '荒芜阈值：状况低于此值挂「荒芜」（0–100）', rules.desolationThreshold, { min: 0, max: 100 });
        inputs.plagueThreshold = numberField(form, '瘟疫阈值：状况不高于此值挂「瘟疫」（0–100）', rules.plagueThreshold, { min: 0, max: 100 });
        inputs.plagueWarCount = numberField(form, '连续战乱/冲击次数达到即挂「瘟疫」（1–10）', rules.plagueWarCount, { min: 1, max: 10 });
        inputs.recoveryPerTurn = numberField(form, '休养生息每次恢复状况（0–20）', rules.recoveryPerTurn, { min: 0, max: 20 });
        const toolbar = el('div', null, 'amin-toolbar'); form.append(toolbar);
        button(toolbar, '保存参数', () => {
            const next = structuredClone(c), value = key => Number(inputs[key].value);
            next.rulesConfig = normalizeRules({
                intensity: { light: value('intensity.light'), medium: value('intensity.medium'), severe: value('intensity.severe') },
                battleType: Object.fromEntries(BATTLE_TYPES.map(t => [t, value('battleType.' + t)])),
                conditionLoss: { light: value('conditionLoss.light'), medium: value('conditionLoss.medium'), severe: value('conditionLoss.severe') },
                desolationThreshold: value('desolationThreshold'), plagueThreshold: value('plagueThreshold'), plagueWarCount: value('plagueWarCount'), recoveryPerTurn: value('recoveryPerTurn'),
            });
            api.saveCampaign(next); render(); say('棋局参数已保存');
        }, true);
        const followCard = card('增量跟随');
        const label = el('label', '每轮生成附带沙盘协议，AI 在回复末尾输出 [FACTION_UPDATE] 隐藏块');
        const check = el('input'); check.type = 'checkbox'; check.checked = api.snapshot().follow; label.append(check); followCard.append(label);
        followCard.append(el('p', '解析出的变更进入待确认队列，面板内确认后才写入；非法块自动忽略。', 'amin-fx-delta'));
        check.onchange = () => { try { api.setFollow(check.checked); say(check.checked ? '已开启增量跟随' : '已关闭增量跟随'); } catch (e) { say(e.message); check.checked = !check.checked; } };
        const danger = card('危险操作');
        const tools = el('div', null, 'amin-toolbar'); danger.append(tools);
        button(tools, '删除当前棋局', () => { if (confirm('删除棋局「' + c.name + '」？纪事一并删除。')) { api.deleteCampaign(c.id); render(); say('棋局已删除'); } });
    }

    async function runAI(mode, options = {}) {
        const ai = getAI();
        if (!ai) throw Error('共享 AI 尚未就绪，请先打开 AI 设置');
        if (running) throw Error('已有生成任务进行中');
        const controller = new AbortController(); running = controller;
        try {
            say(mode === 'review' ? 'AI 正在通读近期剧情…' : 'AI 正在生成沙盘…');
            const campaign = current();
            if ((mode === 'review' || mode === 'regenerate') && !campaign) throw Error('请先创建棋局');
            const text = await requestFactions({ ai, ctx: api.context(), mode, campaign, scaleTemplate: options.scaleTemplate ?? campaign.scaleTemplate, name: options.name, extra: options.extra, signal: controller.signal });
            if (mode === 'review') {
                const { summary, proposals, reason } = parseReview(text);
                if (!proposals.length) throw Error(reason === 'invalid' ? 'AI 返回的不是 JSON，未应用' : 'AI 没有提出可用建议');
                const result = applyUpdate(campaign, proposalsToUpdate(proposals));
                if (!result.events.length) throw Error('建议没有匹配到沙盘内容：' + result.rejected.map(r => r.ref || r.kind).join('、'));
                showApplyPreview('剧情盘点', result, summary);
            } else {
                const { campaign: board, reason } = parseBoard(text, { scaleTemplate: options.scaleTemplate, name: options.name, keepId: mode === 'regenerate' ? campaign : null });
                if (!board) throw Error(reason);
                wizard = false; preview = null;
                drawBoardPreviewInline(board);
            }
        } finally { running = null; }
    }
    function drawBoardPreviewInline(board) {
        body.replaceChildren(); tabs.replaceChildren(); tabs.hidden = true; drawContext();
        drawBoardPreview(board, board.history.at(-1)?.description);
        say('请核对预览后确认写入');
    }

    function render() {
        // 渲染纪律：任何全量重渲染先清空全部动态容器，再重建，杜绝实例叠加。
        body.replaceChildren(); tabs.replaceChildren();
        if (!drawContext()) return;
        drawPendingNotice();
        if (preview) { drawPreview(); return; }
        const c = current();
        if (!c || wizard) { tabs.hidden = true; drawWizard(); return; }
        tabs.hidden = false;
        for (const name of ['势力榜', '地区网格', '动态纪事', '沙盘设置']) {
            const b = el('button', name); b.type = 'button';
            if (name === selected) b.setAttribute('aria-selected', 'true'); else b.setAttribute('aria-selected', 'false');
            b.onclick = () => { selected = name; render(); };
            tabs.append(b);
        }
        if (selected === '势力榜') drawFactions(c);
        else if (selected === '地区网格') drawRegions(c);
        else if (selected === '动态纪事') drawHistory(c);
        else drawSettings(c);
    }

    const unsubscribe = api.subscribe(() => {
        status.textContent = api.status();
        const has = !!api.pending();
        if (has !== seenPending) { seenPending = has; render(); }
    });
    const ctx = api.context(), events = ctx?.eventTypes ?? ctx?.event_types ?? {};
    const chatChanged = () => { preview = null; wizard = false; seenPending = false; render(); };
    if (events.CHAT_CHANGED) ctx.eventSource?.on(events.CHAT_CHANGED, chatChanged);
    const handle = {
        open() { seenPending = !!api.pending(); render(); },
        dispose() { unsubscribe(); if (events.CHAT_CHANGED) ctx.eventSource?.removeListener?.(events.CHAT_CHANGED, chatChanged); page.remove(); if (activeView === handle) activeView = null; },
    };
    activeView = handle;
    render();
    return handle;
}
