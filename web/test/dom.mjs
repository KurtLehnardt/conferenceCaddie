// A small DOM for the render tests: enough of document, elements and text nodes for Preact to draw
// a component into, and helpers to find what it drew. No layout, no styles beyond what Preact sets,
// and events only as listeners kept on the element. Import env.mjs first; this adds the element
// factories to its document.
import { h, render } from 'preact';

const SVG = 'http://www.w3.org/2000/svg';
const HTML = 'http://www.w3.org/1999/xhtml';

class Node {
  parentNode = null;
  childNodes = [];
  ownerDocument = globalThis.document;

  get firstChild() {
    return this.childNodes[0] ?? null;
  }

  get lastChild() {
    return this.childNodes[this.childNodes.length - 1] ?? null;
  }

  get nextSibling() {
    const siblings = this.parentNode?.childNodes;
    if (!siblings) return null;
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }

  get previousSibling() {
    const siblings = this.parentNode?.childNodes;
    if (!siblings) return null;
    return siblings[siblings.indexOf(this) - 1] ?? null;
  }

  insertBefore(node, ref) {
    if (node.parentNode) node.remove();
    node.parentNode = this;
    const at = ref ? this.childNodes.indexOf(ref) : -1;
    if (at < 0) this.childNodes.push(node);
    else this.childNodes.splice(at, 0, node);
    return node;
  }

  appendChild(node) {
    return this.insertBefore(node, null);
  }

  removeChild(node) {
    const at = this.childNodes.indexOf(node);
    if (at >= 0) this.childNodes.splice(at, 1);
    node.parentNode = null;
    return node;
  }

  remove() {
    this.parentNode?.removeChild(this);
  }

  contains(node) {
    for (let n = node; n; n = n.parentNode) if (n === this) return true;
    return false;
  }
}

class Text extends Node {
  nodeType = 3;
  constructor(data) {
    super();
    this.data = String(data);
  }

  get textContent() {
    return this.data;
  }
}

class Element extends Node {
  nodeType = 1;
  attrs = new Map();
  listeners = new Map();
  style = {
    cssText: '',
    setProperty(name, value) {
      this[name] = value;
    },
  };

  constructor(namespaceURI, localName) {
    super();
    this.namespaceURI = namespaceURI;
    this.localName = localName;
  }

  get nodeName() {
    return this.localName.toUpperCase();
  }

  get tagName() {
    return this.nodeName;
  }

  get attributes() {
    return [...this.attrs].map(([name, value]) => ({ name, value }));
  }

  setAttribute(name, value) {
    this.attrs.set(name, String(value));
  }

  getAttribute(name) {
    return this.attrs.has(name) ? this.attrs.get(name) : null;
  }

  hasAttribute(name) {
    return this.attrs.has(name);
  }

  removeAttribute(name) {
    this.attrs.delete(name);
  }

  addEventListener(type, fn) {
    this.listeners.set(type, fn);
  }

  removeEventListener(type) {
    this.listeners.delete(type);
  }

  get textContent() {
    return this.childNodes.map((n) => n.textContent).join('');
  }

  set textContent(value) {
    this.childNodes = [];
    if (value) this.appendChild(new Text(value));
  }

  /** The classes in the class attribute. */
  get classes() {
    return (this.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
  }
}

const doc = globalThis.document;
doc.createElementNS = (ns, name) => new Element(ns ?? HTML, name);
doc.createElement = (name) => new Element(HTML, name);
doc.createTextNode = (data) => new Text(data);

/** Every element under [root] (depth first, [root] included) that [match] accepts. */
export function findAll(root, match) {
  const out = [];
  const walk = (n) => {
    if (n.nodeType === 1 && match(n)) out.push(n);
    for (const c of n.childNodes) walk(c);
  };
  walk(root);
  return out;
}

/** Elements under [root] with the class [name]. */
export function byClass(root, name) {
  return findAll(root, (e) => e.classes.includes(name));
}

/** Elements under [root] with the tag [name]. */
export function byTag(root, name) {
  return findAll(root, (e) => e.localName === name);
}

/** The text of [node] without the parts hidden from screen readers (aria-hidden). */
export function spokenText(node) {
  if (node.nodeType === 3) return node.data;
  if (node.getAttribute('aria-hidden') === 'true') return '';
  return node.childNodes.map(spokenText).join('');
}

/** The text of [node] a sighted reader sees: without the screen-reader-only parts (.sr-only). */
export function visibleText(node) {
  if (node.nodeType === 3) return node.data;
  if (node.classes.includes('sr-only')) return '';
  return node.childNodes.map(visibleText).join('');
}

/**
 * Draws [component] with [props] into a new root element and returns the root and an unmount
 * function, which the test calls so no effect outlives it.
 */
export function draw(component, props = {}) {
  const root = new Element(HTML, 'div');
  render(h(component, props), root);
  return { root, unmount: () => render(null, root) };
}

export { SVG };
