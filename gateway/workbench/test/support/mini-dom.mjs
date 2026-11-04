/**
 * 视图测试用的最小 DOM。只实现 resources.mjs 实际用到的接口：
 * 建节点、挂载、文本聚合、属性、类名、监听与按 id/类名/tag 查找。
 *
 * 不模拟布局、样式、事件冒泡或无障碍树；它不是浏览器，只用来验证
 * 视图在给定状态下的 DOM 文本与结构，不需要任何外部运行时依赖。
 */

class MiniNode {
    constructor(nodeType) {
        this.nodeType = nodeType;
        this.children = [];
    }

    get textContent() {
        return this._collectText();
    }

    set textContent(value) {
        this.children = [];
        this._ownText = String(value);
    }

    _collectText() {
        const own = this._ownText ?? '';
        return own + this.children.map(child => child.textContent).join('');
    }
}

class MiniText extends MiniNode {
    constructor(text) {
        super(3);
        this._ownText = String(text);
        this.tagName = '#text';
    }
}

export class MiniElement extends MiniNode {
    constructor(tagName) {
        super(1);
        this.tagName = String(tagName).toUpperCase();
        this.attributes = new Map();
        this.dataset = {};
        this.listeners = new Map();
        this.className = '';
        this.hidden = false;
        this.disabled = false;
        this.tabIndex = -1;
        this._ownText = '';
    }

    set textContent(value) {
        this.children = [];
        this._ownText = String(value);
    }

    get textContent() {
        return this._collectText();
    }

    append(...nodes) {
        for (const node of nodes.flat(Infinity)) {
            if (node === null || node === undefined) continue;
            this.children.push(node instanceof MiniNode ? node : new MiniText(String(node)));
        }
    }

    replaceChildren(...nodes) {
        this.children = [];
        this._ownText = '';
        this.append(...nodes);
    }

    setAttribute(name, value) {
        this.attributes.set(name, String(value));
        if (name === 'class') this.className = String(value);
    }

    getAttribute(name) {
        if (name === 'class') return this.className === '' ? null : this.className;
        return this.attributes.has(name) ? this.attributes.get(name) : null;
    }

    hasAttribute(name) {
        return name === 'class' ? this.className !== '' : this.attributes.has(name);
    }

    removeAttribute(name) {
        this.attributes.delete(name);
        if (name === 'class') this.className = '';
    }

    get classList() {
        const read = () => this.className.split(/\s+/).filter(Boolean);
        const write = names => { this.className = names.join(' '); };
        return {
            contains: name => read().includes(name),
            add: (...names) => {
                const current = read();
                for (const name of names) if (!current.includes(name)) current.push(name);
                write(current);
            },
            remove: (...names) => write(read().filter(name => !names.includes(name))),
            toggle: (name, force) => {
                const current = read();
                const present = current.includes(name);
                const next = force === undefined ? !present : Boolean(force);
                if (next && !present) current.push(name);
                write(next ? current : current.filter(item => item !== name));
                return next;
            },
            get length() {
                return read().length;
            },
        };
    }

    addEventListener(type, handler) {
        const list = this.listeners.get(type) ?? [];
        list.push(handler);
        this.listeners.set(type, list);
    }

    removeEventListener(type, handler) {
        const list = this.listeners.get(type) ?? [];
        this.listeners.set(type, list.filter(item => item !== handler));
    }

    /** 直接触发监听器；不模拟冒泡与默认行为。 */
    dispatch(type) {
        for (const handler of this.listeners.get(type) ?? []) handler({ type, target: this });
    }

    click() {
        if (this.disabled) return;
        this.dispatch('click');
    }

    descendants() {
        const found = [];
        const walk = node => {
            if (node instanceof MiniElement) found.push(node);
            for (const child of node.children) walk(child);
        };
        for (const child of this.children) walk(child);
        return found;
    }

    matches(selector) {
        if (selector.startsWith('#')) return this.getAttribute('id') === selector.slice(1);
        if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
        return this.tagName === selector.toUpperCase();
    }

    querySelector(selector) {
        return this.descendants().find(node => node.matches(selector)) ?? null;
    }

    querySelectorAll(selector) {
        return this.descendants().filter(node => node.matches(selector));
    }
}

/**
 * 把最小的 document / Node 装到全局。mountResources 只在调用时访问它们，
 * 因此装好之后再导入视图模块即可。
 */
export function installMiniDom() {
    const body = new MiniElement('body');
    globalThis.Node = MiniNode;
    globalThis.document = {
        body,
        createElement: tagName => new MiniElement(tagName),
        createTextNode: text => new MiniText(text),
        getElementById: id => body.querySelector('#' + id),
        querySelector: selector => body.querySelector(selector),
        querySelectorAll: selector => body.querySelectorAll(selector),
    };
    return { body, document: globalThis.document };
}

export function createHost() {
    const host = new MiniElement('div');
    host.setAttribute('id', 'resources-mount');
    return host;
}

/** 在给定根节点（含自身）里按 id 找元素。 */
export function byId(root, id) {
    if (root instanceof MiniElement && root.getAttribute('id') === id) return root;
    return root.querySelector('#' + id);
}

export function textOf(root, id) {
    return byId(root, id)?.textContent ?? null;
}

export { MiniNode, MiniText };
