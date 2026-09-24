// Explicit structural edits. Never rewrite historical snapshots or free-form prose.
export function relocateStatus(state, rules, operation) {
    const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
    const { kind, project, target, field, base } = operation;
    const safe = name => typeof name === 'string' && /^[\p{L}\p{N}_]{1,32}$/u.test(name)
        && !['__proto__', 'prototype', 'constructor'].includes(name);
    if (!['rename', 'move'].includes(kind) || !safe(project) || !safe(target)
        || kind === 'move' && !safe(field)) throw Error('项目或变量名称无效。');
    const next = structuredClone(state);
    const projects = next?.项目;
    if (!projects || !own(projects, project)) throw Error('来源项目已被删除，请刷新。');
    const source = kind === 'rename' ? projects[project] : projects[project][field];
    if (source === undefined || JSON.stringify(source) !== JSON.stringify(base)) {
        throw Error('来源内容已更新，请取消并刷新后重试。');
    }
    if (project === target) throw Error('请选择不同的目标名称或项目。');
    let from = `状态栏.项目.${project}`, to = `状态栏.项目.${target}`;
    if (kind === 'rename') {
        if (own(projects, target)) throw Error('项目名称已存在。');
        next.项目 = Object.fromEntries(Object.entries(projects).map(([k, v]) => [k === project ? target : k, v]));
    } else {
        if (!own(projects, target)) throw Error('目标项目已被删除，请刷新。');
        if (own(projects[target], field)) throw Error('目标项目已有同名变量，未覆盖。');
        projects[target][field] = projects[project][field];
        delete projects[project][field];
        from += `.${field}`; to += `.${field}`;
    }
    const matches = path => path === from || path.startsWith(from + '.') || path.startsWith(from + '[');
    const entries = Object.entries(rules ?? {});
    const renamed = entries.map(([path, rule]) => [matches(path) ? to + path.slice(from.length) : path, rule]);
    if (new Set(renamed.map(([path]) => path)).size !== renamed.length) throw Error('目标路径已有变量规则，未覆盖。');
    return { state: next, rules: Object.fromEntries(renamed), rulesChanged: entries.some(([path]) => matches(path)) };
}
