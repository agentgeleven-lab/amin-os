// 四套规模模板：只定义默认指标集、地区命名习惯与数值量级（人口单位）。
// 模板不携带规则系数；规则默认值见 model.js 的 DEFAULT_RULES。
export const TEMPLATES = {
    street: {
        id: 'street', name: '街区格局', blurb: '街区与场子的势力格局，人口几十到几百。',
        regionNouns: ['街区', '场子', '码头', '市场', '巷子'],
        metrics: [
            { key: 'manpower', label: '人手', max: 100 },
            { key: 'cash', label: '现金', max: 100 },
            { key: 'reputation', label: '声望', max: 100 },
            { key: 'heat', label: '警方关注', max: 100 },
        ],
        population: { min: 30, max: 800, unit: '人', abstract: false },
        colors: ['#e0564a', '#4f9be0', '#e0b44f', '#8a6fd6', '#4fb87a', '#d6709c'],
    },
    corporate: {
        id: 'corporate', name: '商业版图', blurb: '市场区域与业务线的商业格局，人口为抽象指数。',
        regionNouns: ['市场区域', '业务线', '园区', '渠道', '部门'],
        metrics: [
            { key: 'funds', label: '资金', max: 100 },
            { key: 'share', label: '份额', max: 100 },
            { key: 'tech', label: '技术', max: 100 },
            { key: 'press', label: '舆论', max: 100 },
        ],
        population: { min: 10, max: 100, unit: '指数', abstract: true },
        colors: ['#3f8ea5', '#e08a4f', '#6fae57', '#b25f8f', '#7f8ed6', '#c9c04f'],
    },
    court: {
        id: 'court', name: '朝堂格局', blurb: '部门、领地与人脉圈的势力消长，抽象为主、少量具体。',
        regionNouns: ['部门', '领地', '人脉圈', '衙署', '行省'],
        metrics: [
            { key: 'power', label: '权势', max: 100 },
            { key: 'troops', label: '兵力', max: 100 },
            { key: 'favor', label: '圣眷', max: 100 },
            { key: 'clique', label: '党羽', max: 100 },
        ],
        population: { min: 100, max: 50000, unit: '口', abstract: false },
        colors: ['#b8863f', '#8f4f4f', '#4f7a63', '#5a5f9e', '#a1704f', '#6f8f9e'],
    },
    interstate: {
        id: 'interstate', name: '列国格局', blurb: '省、州与城市的列国格局，人口从万级到千万级。',
        regionNouns: ['省', '州', '城市', '要塞', '边疆'],
        metrics: [
            { key: 'military', label: '军事', max: 100 },
            { key: 'economy', label: '经济', max: 100 },
            { key: 'stability', label: '稳定', max: 100 },
            { key: 'diplomacy', label: '外交', max: 100 },
        ],
        population: { min: 10000, max: 10000000, unit: '人', abstract: false },
        colors: ['#5a7fa5', '#a55a5a', '#5aa583', '#a58f5a', '#7a5aa5', '#5aa5a8'],
    },
};
export const template = id => TEMPLATES[id] ?? null;
export const templateList = () => Object.values(TEMPLATES);
export const TEMPLATE_IDS = () => Object.keys(TEMPLATES);
