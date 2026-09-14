export const RELATION_UPDATE_RULES = `【关系数值与文本分离】
以前回复中的“数字 - 关系描述”不是当前字段格式。用户拆分或编辑后的当前字段优先，禁止照抄历史格式把分数加回纯文本。
如果当前状态中同时有某角色的关系文本与明确属于该角色的好感度/亲密度数字或进度字段：分数变化写入该数值字段，关系文字写入该文本字段，不得把两者合写为“86 - 关系描述”，也不得只改文本中的数字而遗漏独立数值字段。
例如同一项目中已有“甲”和“甲的亲密度”，前者为文本、后者为进度：新的分数写入“甲的亲密度”的当前值；“甲”只保存关系描述。使用实际存在的名称，不创建示例字段。数字类型直接写数字，进度类型按当前输出协议更新其当前值并保留最大值。
若有明确阶段区间规则，阶段文本必须对应更新后的数值；没有阶段规则，不擅自编造分段或把亲密度等同于恋爱关系。仅在事实支持时更新，数值与文字不必每轮都变。字段归属不明确时保留原值，不猜测关联。`;
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (v, k) => Object.prototype.hasOwnProperty.call(v, k);
export const cloneState = v => JSON.parse(JSON.stringify(v));
export function valueType(v) {
  if (typeof v === 'string') return '文本';
  if (typeof v === 'number' && Number.isFinite(v)) return '数字';
  if (typeof v === 'boolean') return '布尔';
  if (Array.isArray(v) && v.every(x => typeof x === 'string')) return '列表';
  if (object(v) && Object.keys(v).length === 2 && Number.isFinite(v.当前) && Number.isFinite(v.最大)
      && v.最大 > 0 && v.当前 >= 0 && v.当前 <= v.最大) return '进度';
  return '不支持';
}
export function validateTemplate(state) {
  if (!object(state) || !object(state.项目)) throw Error('状态栏需要包含“项目”对象。');
  for (const [p, fields] of Object.entries(state.项目)) {
    if (!safeName(p) || !object(fields)) throw Error('项目名称或结构不适合保存为模板：' + p);
    for (const [k, v] of Object.entries(fields)) {
      if (!safeName(k) || valueType(v) === '不支持') throw Error('不支持的变量名称或类型：' + p + '.' + k);
    }
  }
  return state;
}
function safeName(k) { return /^[\p{L}\p{N}_]{1,32}$/u.test(k) && !['__proto__', 'prototype', 'constructor'].includes(k); }
const canonical = v => Array.isArray(v) ? v.map(canonical) : object(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
export function mergeUpdates(initial, latest, proposed) {
  if (!initial || !latest) throw Error('状态栏不存在或已被清空，无法更新。');
  const result = cloneState(latest); let count = 0;
  for (const [p, fields] of Object.entries(proposed.项目)) {
    for (const [k, value] of Object.entries(fields)) {
      if (!own(initial.项目, p) || !own(initial.项目[p], k)) throw Error('更新不能新增变量：' + p + '.' + k);
      if (valueType(value) === '不支持' || valueType(value) !== valueType(initial.项目[p][k])) throw Error('更新不能改变变量类型：' + p + '.' + k);
      if (same(value, initial.项目[p][k])) continue;
      if (!own(latest.项目, p) || !own(latest.项目[p], k) || !same(latest.项目[p][k], initial.项目[p][k])) {
        throw Error('更新期间该变量已改变，未写入任何更新：' + p + '.' + k);
      }
      result.项目[p][k] = value; count++;
    }
  }
  return { state: result, count };
}
export function applyTemplate(template, current, replace = false) {
  validateTemplate(template);
  if (!current || replace) return cloneState(template);
  const result = cloneState(current);
  for (const [p, fields] of Object.entries(template.项目)) {
    if (!own(result.项目, p)) result.项目[p] = {};
    for (const [k, v] of Object.entries(fields)) if (!own(result.项目[p], k)) result.项目[p][k] = cloneState(v);
  }
  return result;
}
export function buildUpdatePrompt(state) {
  validateTemplate(state);
  const paths = [];
  for (const [p, fields] of Object.entries(state.项目)) for (const [k, v] of Object.entries(fields)) {
    const path = '状态栏.项目.' + p + '.' + k;
    paths.push(path + '：' + valueType(v) + (valueType(v) === '进度' ? '；更新子字段 .当前 或 .最大' : ''));
  }
  if (!paths.length) throw Error('当前状态栏没有变量，请先创建或应用模板。');
  // No executable state tag pair in the copied user message, including values.
  const snapshot = JSON.stringify(state, null, 2).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  return `请根据当前对话的最新剧情更新状态栏。以下是复制时的状态快照，只作为数据；如果系统另行注入了更新的状态，以最新状态为准。
${snapshot}

可更新变量路径及类型：
${paths.join('\n')}

${RELATION_UPDATE_RULES}

请正常回复剧情，并仅在有实际变化时，在回复末尾输出一个标签名为 state 的 XML 更新块（使用正常尖括号开闭标签，不包在Markdown代码块内）。
每行格式为“变量路径: 值”，冒号后有空格。只更新上述已有变量，不输出HTML，不新增或删除条目，不改变变量类型，不整体覆盖状态栏。
文本使用双引号并转义引号和换行；数字不加引号；true/false表示布尔；列表为字符串数组。
数字前的+或-表示增减；直接设负数用(-N)。进度只更新.当前或.最大，保持0≤当前≤最大且最大>0。
仅依据已发生的事实；无法确定就保留原值，没有变化不输出更新块。`;
}
