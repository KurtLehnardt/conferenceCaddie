// A small, dependency-free JSON Schema (draft 2020-12) validator for the shared contracts.
//
// It implements the subset of draft 2020-12 that the schemas under contracts/schema/ use, and it
// refuses a schema that uses any other keyword, so a schema can never silently rely on a keyword
// this validator would ignore. Supported keywords:
//
//   core         $schema $id $ref $defs $comment, and the annotations title description
//                examples default deprecated readOnly writeOnly
//   any type     type enum const allOf anyOf oneOf not if then else
//   numbers      minimum maximum exclusiveMinimum exclusiveMaximum multipleOf
//   strings      minLength maxLength pattern format
//   arrays       items prefixItems minItems maxItems uniqueItems
//   objects      properties required additionalProperties patternProperties propertyNames
//                minProperties maxProperties dependentRequired
//
// `format` is asserted (draft 2020-12 treats it as an annotation by default) for date-time, date,
// uri and uuid, and any other format name is refused. Patterns are compiled with the `u` flag.
// Lengths count Unicode code points, as the specification requires.
//
// Options:
//   schemas  further schemas, registered by their $id, that a $ref may point into.
//   closed   producer mode. A schema that declares `"type": "object"` (alone or in a list), lists
//            `properties` and has neither `additionalProperties` nor `patternProperties` is
//            treated as if it said `additionalProperties: false`. Subschemas without a declared
//            type (the branches of if, then, else, allOf and the like) are never closed, so they
//            can add constraints to properties declared elsewhere. Consumers validate without it (unknown fields are
//            ignored, so newer producers stay readable); producers and fixtures validate with it,
//            so a misspelt field fails.

const ANNOTATIONS = new Set(['$schema', '$id', '$comment', 'title', 'description', 'examples', 'default', 'deprecated', 'readOnly', 'writeOnly']);
const KEYWORDS = new Set([
  ...ANNOTATIONS, '$ref', '$defs',
  'type', 'enum', 'const', 'allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'minLength', 'maxLength', 'pattern', 'format',
  'items', 'prefixItems', 'minItems', 'maxItems', 'uniqueItems',
  'properties', 'required', 'additionalProperties', 'patternProperties', 'propertyNames',
  'minProperties', 'maxProperties', 'dependentRequired',
]);
const TYPES = new Set(['null', 'boolean', 'object', 'array', 'number', 'integer', 'string']);
const FORMATS = {
  'date-time': (s) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/.exec(s);
    return Boolean(m) && validDate(+m[1], +m[2], +m[3]) && +m[4] < 24 && +m[5] < 60 && +m[6] < 61 && Number.isFinite(Date.parse(s));
  },
  date: (s) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    return Boolean(m) && validDate(+m[1], +m[2], +m[3]);
  },
  uri: (s) => {
    if (!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(s)) return false;
    try {
      new URL(s);
      return true;
    } catch {
      return false;
    }
  },
  uuid: (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s),
};

function validDate(y, m, d) {
  if (m < 1 || m > 12 || d < 1) return false;
  const days = [31, (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return d <= days[m - 1];
}

export class SchemaError extends Error {}

// value / step is an integer, allowing for binary rounding (0.3 is a multiple of 0.1).
function isMultiple(value, step) {
  const q = value / step;
  return Number.isFinite(q) && Math.abs(q - Math.round(q)) <= 1e-9 * Math.max(1, Math.abs(q));
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
const pointerEscape = (s) => String(s).replace(/~/g, '~0').replace(/\//g, '~1');

// Equality as JSON values: key order does not matter, 1 and 1.0 are equal.
function jsonEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => jsonEqual(x, b[i]));
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && jsonEqual(a[k], b[k]));
}

// Checks every keyword of a schema and its subschemas once, and collects $id and $defs targets.
function checkSchema(schema, where) {
  if (typeof schema === 'boolean') return;
  if (!isObject(schema)) throw new SchemaError(`${where}: a schema must be an object or a boolean`);
  for (const k of Object.keys(schema)) {
    if (!KEYWORDS.has(k)) throw new SchemaError(`${where}: unsupported keyword "${k}"`);
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    for (const t of types) if (!TYPES.has(t)) throw new SchemaError(`${where}: unknown type "${t}"`);
  }
  if (schema.format !== undefined && !FORMATS[schema.format]) throw new SchemaError(`${where}: unsupported format "${schema.format}"`);
  if (schema.pattern !== undefined) new RegExp(schema.pattern, 'u');
  for (const k of Object.keys(schema.patternProperties ?? {})) new RegExp(k, 'u');
  for (const k of ['not', 'if', 'then', 'else', 'items', 'additionalProperties', 'propertyNames']) {
    if (schema[k] !== undefined) checkSchema(schema[k], `${where}/${k}`);
  }
  for (const k of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) {
    if (schema[k] === undefined) continue;
    if (!Array.isArray(schema[k]) || !schema[k].length) throw new SchemaError(`${where}/${k}: must be a non-empty array`);
    schema[k].forEach((s, i) => checkSchema(s, `${where}/${k}/${i}`));
  }
  for (const k of ['properties', 'patternProperties', '$defs']) {
    if (schema[k] === undefined) continue;
    if (!isObject(schema[k])) throw new SchemaError(`${where}/${k}: must be an object`);
    for (const [name, s] of Object.entries(schema[k])) checkSchema(s, `${where}/${k}/${pointerEscape(name)}`);
  }
}

function resolvePointer(root, fragment, ref) {
  if (fragment === '' || fragment === '#') return root;
  if (!fragment.startsWith('#/')) throw new SchemaError(`unsupported $ref "${ref}" (only JSON pointers)`);
  let node = root;
  for (const raw of fragment.slice(2).split('/')) {
    const key = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~');
    if (node === null || typeof node !== 'object' || !Object.hasOwn(node, key)) throw new SchemaError(`unresolvable $ref "${ref}"`);
    node = node[key];
  }
  return node;
}

/**
 * Builds a validator for a root schema. Returns a function instance -> { valid, errors }, where
 * each error is { path, keyword, message } and path is a JSON pointer into the instance.
 */
export function compile(rootSchema, { schemas = [], closed = false } = {}) {
  const registry = new Map();
  for (const s of [rootSchema, ...schemas]) {
    checkSchema(s, s?.$id ?? '#');
    if (isObject(s) && typeof s.$id === 'string') registry.set(s.$id, s);
  }

  // Each frame is { root, base }: the document a "#/..." pointer resolves in and its base URI.
  function deref(ref, frame) {
    let target;
    let base = frame.base;
    if (ref.startsWith('#')) {
      target = resolvePointer(frame.root, ref, ref);
      return { schema: target, frame };
    }
    let url;
    try {
      url = base ? new URL(ref, base) : new URL(ref);
    } catch {
      throw new SchemaError(`$ref "${ref}" cannot be resolved without a base $id`);
    }
    const hash = url.hash;
    url.hash = '';
    const doc = registry.get(url.href);
    if (!doc) throw new SchemaError(`$ref "${ref}" names an unregistered schema ${url.href}`);
    base = url.href;
    target = resolvePointer(doc, hash ? `#${decodeURIComponent(hash.slice(1))}` : '', ref);
    return { schema: target, frame: { root: doc, base } };
  }

  function run(schema, value, path, frame, errors) {
    if (schema === true) return;
    if (schema === false) {
      errors.push({ path, keyword: 'false', message: 'no value is allowed here' });
      return;
    }
    const fail = (keyword, message) => errors.push({ path, keyword, message });

    if (schema.$ref !== undefined) {
      const r = deref(schema.$ref, frame);
      run(r.schema, value, path, r.frame, errors);
    }

    const t = typeOf(value);
    if (schema.type !== undefined) {
      const types = Array.isArray(schema.type) ? schema.type : [schema.type];
      const ok = types.some((want) => want === t || (want === 'integer' && t === 'number' && Number.isInteger(value)) || (want === 'number' && t === 'number'));
      if (!ok) {
        fail('type', `must be ${types.join(' or ')}, got ${t}`);
        return;
      }
    }
    if (schema.const !== undefined && !jsonEqual(value, schema.const)) fail('const', `must equal ${JSON.stringify(schema.const)}`);
    if (schema.enum !== undefined && !schema.enum.some((e) => jsonEqual(value, e))) fail('enum', `must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}`);

    if (t === 'number') {
      if (schema.minimum !== undefined && value < schema.minimum) fail('minimum', `must be >= ${schema.minimum}`);
      if (schema.maximum !== undefined && value > schema.maximum) fail('maximum', `must be <= ${schema.maximum}`);
      if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) fail('exclusiveMinimum', `must be > ${schema.exclusiveMinimum}`);
      if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) fail('exclusiveMaximum', `must be < ${schema.exclusiveMaximum}`);
      if (schema.multipleOf !== undefined && !isMultiple(value, schema.multipleOf)) fail('multipleOf', `must be a multiple of ${schema.multipleOf}`);
    }

    if (t === 'string') {
      const len = [...value].length;
      if (schema.minLength !== undefined && len < schema.minLength) fail('minLength', `must have at least ${schema.minLength} characters`);
      if (schema.maxLength !== undefined && len > schema.maxLength) fail('maxLength', `must have at most ${schema.maxLength} characters`);
      if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) fail('pattern', `must match ${schema.pattern}`);
      if (schema.format !== undefined && !FORMATS[schema.format](value)) fail('format', `must be a valid ${schema.format}`);
    }

    if (t === 'array') {
      if (schema.minItems !== undefined && value.length < schema.minItems) fail('minItems', `must have at least ${schema.minItems} items`);
      if (schema.maxItems !== undefined && value.length > schema.maxItems) fail('maxItems', `must have at most ${schema.maxItems} items`);
      if (schema.uniqueItems === true) {
        for (let i = 0; i < value.length; i++) {
          for (let j = i + 1; j < value.length; j++) {
            if (jsonEqual(value[i], value[j])) {
              fail('uniqueItems', `items ${i} and ${j} are equal`);
              i = value.length;
              break;
            }
          }
        }
      }
      const prefix = schema.prefixItems ?? [];
      prefix.forEach((s, i) => {
        if (i < value.length) run(s, value[i], `${path}/${i}`, frame, errors);
      });
      if (schema.items !== undefined) {
        for (let i = prefix.length; i < value.length; i++) run(schema.items, value[i], `${path}/${i}`, frame, errors);
      }
    }

    if (t === 'object') {
      const keys = Object.keys(value);
      if (schema.minProperties !== undefined && keys.length < schema.minProperties) fail('minProperties', `must have at least ${schema.minProperties} properties`);
      if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) fail('maxProperties', `must have at most ${schema.maxProperties} properties`);
      for (const k of schema.required ?? []) if (!Object.hasOwn(value, k)) fail('required', `is missing required property "${k}"`);
      for (const [k, needs] of Object.entries(schema.dependentRequired ?? {})) {
        if (Object.hasOwn(value, k)) for (const n of needs) if (!Object.hasOwn(value, n)) fail('dependentRequired', `has "${k}" but is missing "${n}"`);
      }
      const props = schema.properties ?? {};
      const patterns = Object.entries(schema.patternProperties ?? {}).map(([p, s]) => [new RegExp(p, 'u'), s]);
      let additional = schema.additionalProperties;
      const declaresObject = schema.type === 'object' || (Array.isArray(schema.type) && schema.type.includes('object'));
      if (additional === undefined && closed && declaresObject && schema.properties !== undefined && schema.patternProperties === undefined) additional = false;
      for (const k of keys) {
        const childPath = `${path}/${pointerEscape(k)}`;
        if (schema.propertyNames !== undefined) run(schema.propertyNames, k, childPath, frame, errors);
        let matched = false;
        if (Object.hasOwn(props, k)) {
          matched = true;
          run(props[k], value[k], childPath, frame, errors);
        }
        for (const [re, s] of patterns) {
          if (re.test(k)) {
            matched = true;
            run(s, value[k], childPath, frame, errors);
          }
        }
        if (!matched && additional !== undefined) {
          if (additional === false) errors.push({ path: childPath, keyword: 'additionalProperties', message: `unknown property "${k}"` });
          else run(additional, value[k], childPath, frame, errors);
        }
      }
    }

    for (const s of schema.allOf ?? []) run(s, value, path, frame, errors);
    if (schema.anyOf !== undefined) {
      const ok = schema.anyOf.some((s) => {
        const e = [];
        run(s, value, path, frame, e);
        return e.length === 0;
      });
      if (!ok) fail('anyOf', 'must match at least one of the alternatives');
    }
    if (schema.oneOf !== undefined) {
      const n = schema.oneOf.filter((s) => {
        const e = [];
        run(s, value, path, frame, e);
        return e.length === 0;
      }).length;
      if (n !== 1) fail('oneOf', `must match exactly one alternative (matched ${n})`);
    }
    if (schema.not !== undefined) {
      const e = [];
      run(schema.not, value, path, frame, e);
      if (e.length === 0) fail('not', 'must not match the schema under "not"');
    }
    if (schema.if !== undefined) {
      const e = [];
      run(schema.if, value, path, frame, e);
      const branch = e.length === 0 ? schema.then : schema.else;
      if (branch !== undefined) run(branch, value, path, frame, errors);
    }
  }

  // Every $ref of every registered document must resolve now, not only when a branch is reached.
  const walkRefs = (schema, frame) => {
    if (!isObject(schema)) return;
    if (typeof schema.$ref === 'string') deref(schema.$ref, frame);
    for (const k of ['not', 'if', 'then', 'else', 'items', 'additionalProperties', 'propertyNames']) walkRefs(schema[k], frame);
    for (const k of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) for (const s of schema[k] ?? []) walkRefs(s, frame);
    for (const k of ['properties', 'patternProperties', '$defs']) for (const s of Object.values(schema[k] ?? {})) walkRefs(s, frame);
  };
  for (const s of [rootSchema, ...schemas]) walkRefs(s, { root: s, base: isObject(s) && typeof s.$id === 'string' ? s.$id : null });

  const rootFrame = { root: rootSchema, base: isObject(rootSchema) && typeof rootSchema.$id === 'string' ? rootSchema.$id : null };
  return (instance) => {
    const errors = [];
    run(rootSchema, instance, '', rootFrame, errors);
    return { valid: errors.length === 0, errors };
  };
}

/** One-shot validation. Same options as compile(). */
export function validate(schema, instance, options) {
  return compile(schema, options)(instance);
}

/** Formats a result's errors as one line each, for test output. */
export const formatErrors = (errors) => errors.map((e) => `${e.path || '(root)'}: ${e.message} [${e.keyword}]`).join('\n');
