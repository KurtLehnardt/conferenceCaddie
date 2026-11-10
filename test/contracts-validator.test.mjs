// The dependency-free JSON Schema validator in contracts/js/validate.mjs: each keyword the
// contract schemas use, the refusal of keywords it does not implement, and closed (producer) mode.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compile, validate, SchemaError } from '../contracts/js/validate.mjs';

const ok = (schema, value, opts) => assert.equal(validate(schema, value, opts).valid, true, JSON.stringify(validate(schema, value, opts).errors));
const no = (schema, value, opts) => assert.equal(validate(schema, value, opts).valid, false, `expected ${JSON.stringify(value)} to fail`);

test('type, including integer, unions and null', () => {
  ok({ type: 'integer' }, 3);
  ok({ type: 'integer' }, 3.0);
  no({ type: 'integer' }, 3.5);
  ok({ type: 'number' }, 3.5);
  ok({ type: ['string', 'null'] }, null);
  no({ type: ['string', 'null'] }, 1);
  no({ type: 'object' }, []);
  no({ type: 'array' }, {});
});

test('enum and const compare JSON values', () => {
  ok({ enum: ['a', null] }, null);
  no({ enum: ['a', null] }, 'b');
  ok({ const: { a: [1, 2] } }, { a: [1, 2] });
  no({ const: { a: [1, 2] } }, { a: [2, 1] });
  ok({ const: [-1, 0, 1] }, [-1, 0, 1]);
});

test('numbers', () => {
  ok({ minimum: 1, maximum: 3 }, 3);
  no({ exclusiveMaximum: 3 }, 3);
  no({ exclusiveMinimum: 1 }, 1);
  ok({ multipleOf: 10 }, 40);
  no({ multipleOf: 10 }, 45);
  ok({ multipleOf: 0.1 }, 0.3);
  ok({ multipleOf: 0.01 }, 1.15);
  no({ multipleOf: 0.1 }, 0.35);
  no({ multipleOf: 0.1 }, 0.3000001);
  ok({ multipleOf: 3 }, 9007199254740990);
  no({ multipleOf: 2 }, 9007199254740991);
  no({ multipleOf: 0.1 }, 1e300);
});

test('strings count code points and patterns use the u flag', () => {
  ok({ maxLength: 2 }, '😀😀');
  no({ maxLength: 1 }, '😀😀');
  ok({ pattern: '^\\p{L}+$' }, 'Grüße');
  no({ pattern: '^[a-z]+$' }, 'Abc');
});

test('formats are asserted', () => {
  ok({ format: 'date-time' }, '2026-11-10T17:00:00.000Z');
  ok({ format: 'date-time' }, '2026-11-10T11:00:00-07:00');
  no({ format: 'date-time' }, '2026-11-10T17:00:00');
  no({ format: 'date-time' }, '2026-02-30T17:00:00Z');
  ok({ format: 'date' }, '2028-02-29');
  no({ format: 'date' }, '2026-02-29');
  ok({ format: 'uri' }, 'https://example.org/a');
  no({ format: 'uri' }, 'example.org/a');
  ok({ format: 'uuid' }, 'e52c391c-b926-4856-9a38-d46c3c10c733');
  no({ format: 'uuid' }, 'E52C391C-B926-4856-9A38-D46C3C10C733');
});

test('arrays', () => {
  ok({ items: { type: 'integer' }, minItems: 1, maxItems: 2 }, [1, 2]);
  no({ items: { type: 'integer' } }, [1, 'a']);
  no({ maxItems: 1 }, [1, 2]);
  no({ uniqueItems: true }, [{ a: 1 }, { a: 1 }]);
  ok({ prefixItems: [{ type: 'string' }], items: { type: 'integer' } }, ['a', 1, 2]);
  no({ prefixItems: [{ type: 'string' }], items: { type: 'integer' } }, ['a', 'b']);
});

test('objects', () => {
  const s = { type: 'object', required: ['a'], properties: { a: { type: 'integer' } }, additionalProperties: false };
  ok(s, { a: 1 });
  no(s, {});
  no(s, { a: 1, b: 2 });
  ok({ additionalProperties: { type: 'integer' } }, { x: 1, y: 2 });
  no({ additionalProperties: { type: 'integer' } }, { x: 'a' });
  ok({ propertyNames: { pattern: '^[a-z]+$' } }, { abc: 1 });
  no({ propertyNames: { pattern: '^[a-z]+$' } }, { ABC: 1 });
  ok({ patternProperties: { '^x-': { type: 'string' } }, additionalProperties: false }, { 'x-a': 's' });
  no({ dependentRequired: { a: ['b'] } }, { a: 1 });
  no({ minProperties: 1 }, {});
});

test('applicators and conditionals', () => {
  ok({ allOf: [{ type: 'integer' }, { minimum: 2 }] }, 2);
  no({ allOf: [{ type: 'integer' }, { minimum: 2 }] }, 1);
  ok({ anyOf: [{ type: 'string' }, { type: 'null' }] }, null);
  no({ oneOf: [{ type: 'integer' }, { type: 'number' }] }, 1);
  ok({ oneOf: [{ type: 'integer' }, { type: 'string' }] }, 1);
  no({ not: { type: 'null' } }, null);
  const cond = { if: { properties: { mode: { const: 'x' } } }, then: { required: ['n'] }, else: { required: ['m'] } };
  ok(cond, { mode: 'x', n: 1 });
  no(cond, { mode: 'x' });
  ok(cond, { mode: 'y', m: 1 });
});

test('$ref inside a document and across registered documents', () => {
  const other = { $id: 'https://example.org/s/other.json', $defs: { Id: { type: 'string', pattern: '^id-' } } };
  const root = { $id: 'https://example.org/s/root.json', $defs: { Local: { $ref: 'other.json#/$defs/Id' } }, type: 'array', items: { $ref: '#/$defs/Local' } };
  const v = compile(root, { schemas: [other] });
  assert.equal(v(['id-1']).valid, true);
  assert.equal(v(['x']).valid, false);
  assert.throws(() => compile({ $ref: 'missing.json' }), SchemaError);
  assert.throws(() => compile({ $id: 'https://example.org/s/x.json', $ref: 'missing.json' }), SchemaError);
  assert.throws(() => compile({ $defs: { a: { $ref: '#/$defs/b' } } }), SchemaError);
});

test('closed mode closes typed object schemas only', () => {
  const s = { type: 'object', properties: { a: { type: 'integer' } }, if: { properties: { a: { const: 1 } } }, then: { properties: { a: { minimum: 1 } } } };
  ok(s, { a: 1, extra: true });
  no(s, { a: 1, extra: true }, { closed: true });
  ok(s, { a: 1 }, { closed: true });
  const errors = validate(s, { a: 1, extra: true }, { closed: true }).errors;
  assert.deepEqual(errors.map((e) => [e.path, e.keyword]), [['/extra', 'additionalProperties']]);
});

test('an unsupported keyword or format is refused, not ignored', () => {
  assert.throws(() => compile({ unevaluatedProperties: false }), SchemaError);
  assert.throws(() => compile({ properties: { a: { contains: {} } } }), SchemaError);
  assert.throws(() => compile({ format: 'email' }), SchemaError);
  assert.throws(() => compile({ type: 'int' }), SchemaError);
});

test('errors carry JSON pointer paths', () => {
  const r = validate({ type: 'object', properties: { list: { items: { type: 'object', properties: { 'a/b': { type: 'string' } } } } } }, { list: [{}, { 'a/b': 1 }] });
  assert.deepEqual(r.errors.map((e) => e.path), ['/list/1/a~1b']);
});
