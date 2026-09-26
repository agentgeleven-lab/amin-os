import test from 'node:test';
import assert from 'node:assert/strict';
import { createFormControls } from '../ui/forms.js';

function fixture(options = {}) {
    const doc = { createElement(tag) {
        return { tagName: tag, ownerDocument: doc, children: [], attributes: {},
            append(...nodes) { this.children.push(...nodes); },
            setAttribute(name, value) { this.attributes[name] = value; },
            set innerHTML(_) { throw Error('Form labels must stay plain text.'); },
        };
    } };
    return { doc, parent: doc.createElement('section'), ui: createFormControls(doc, options) };
}

test('form controls preserve literal text, numeric constraints, zero values and multiline layout', () => {
    const { ui, parent } = fixture({ rows: 5 });
    const numeric = ui.field(parent, '<img src=x>', 0, { type: 'number', min: 0, max: 20, step: 0.5, maxLength: 8 });
    assert.equal(numeric.value, '0'); assert.equal(numeric.type, 'number');
    assert.deepEqual([numeric.min, numeric.max, numeric.step, numeric.maxLength], [0, 20, 0.5, 8]);
    assert.equal(numeric.attributes['aria-label'], '<img src=x>');
    assert.equal(parent.children[0].children[0].textContent, '<img src=x>');
    const multiline = ui.field(parent, '备注', null, { multi: true });
    assert.equal(multiline.value, ''); assert.equal(multiline.rows, 5);
    assert.equal(parent.children[1].className, 'amin-field amin-span-full');
});

test('selection values remain distinct from labels and controls register with their app lock category', () => {
    const calls = [], { ui, parent } = fixture({ register: (node, kind) => calls.push([node, kind]) });
    const select = ui.select(parent, '所有者', [[0, '未分配'], ['hero', '<主角>']], 'hero', 'filter');
    assert.equal(select.value, 'hero');
    assert.deepEqual(select.children.map(option => [option.value, option.textContent]), [['0', '未分配'], ['hero', '<主角>']]);
    const check = ui.checkbox(parent, '允许更新', true);
    assert.equal(check.type, 'checkbox'); assert.equal(check.checked, true);
    assert.equal(parent.children[1].children[0], check);
    assert.deepEqual(calls, [[select, 'filter'], [check, 'form']]);
});

test('separate mounts retain their own document, registration and textarea height', () => {
    const firstCalls = [], secondCalls = [];
    const first = fixture({ rows: 3, register: node => firstCalls.push(node) });
    const second = fixture({ rows: 5, register: node => secondCalls.push(node) });
    const a = first.ui.field(first.parent, '备注', '', { multi: true });
    const b = second.ui.field(second.parent, '备注', '', { multi: true });
    assert.equal(a.ownerDocument, first.doc); assert.equal(b.ownerDocument, second.doc);
    assert.equal(a.rows, 3); assert.equal(b.rows, 5);
    assert.deepEqual(firstCalls, [a]); assert.deepEqual(secondCalls, [b]);
});
