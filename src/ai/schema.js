// Minimal JSON Schema subset used for every structured AI output, whatever the provider.
// Providers may constrain decoding, but the Worker never trusts that: it validates here.
import { AIError } from './errors.js';

function typeMatches(type, v) {
  switch (type) {
    case 'object': return v !== null && typeof v === 'object' && !Array.isArray(v);
    case 'array': return Array.isArray(v);
    case 'string': return typeof v === 'string';
    case 'integer': return Number.isInteger(v);
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'boolean': return typeof v === 'boolean';
    case 'null': return v === null;
    default: return false;
  }
}

export function validate(schema, value, path = '$', errors = []) {
  const types = schema.type ? [].concat(schema.type) : null;
  if (types && !types.some(t => typeMatches(t, value))) {
    errors.push(`${path}: expected ${types.join('|')}`);
    return errors;
  }
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: must be one of ${schema.enum.join(', ')}`);
  if (typeof value === 'string') {
    if (schema.maxLength != null && value.length > schema.maxLength) errors.push(`${path}: longer than ${schema.maxLength}`);
    if (schema.minLength != null && value.length < schema.minLength) errors.push(`${path}: shorter than ${schema.minLength}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum != null && value < schema.minimum) errors.push(`${path}: below ${schema.minimum}`);
    if (schema.maximum != null && value > schema.maximum) errors.push(`${path}: above ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.maxItems != null && value.length > schema.maxItems) errors.push(`${path}: more than ${schema.maxItems} items`);
    if (schema.minItems != null && value.length < schema.minItems) errors.push(`${path}: fewer than ${schema.minItems} items`);
    if (schema.items) value.forEach((v, i) => validate(schema.items, v, `${path}[${i}]`, errors));
  }
  if (typeMatches('object', value)) {
    for (const k of schema.required || []) if (!(k in value)) errors.push(`${path}.${k}: required`);
    for (const [k, v] of Object.entries(value)) {
      if (schema.properties?.[k]) validate(schema.properties[k], v, `${path}.${k}`, errors);
      else if (schema.additionalProperties === false) errors.push(`${path}.${k}: not allowed`);
    }
  }
  return errors;
}

// Constraints some providers reject in their schema dialects; they are still enforced by validate().
const LOCAL_ONLY = new Set(['minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems', 'pattern', 'multipleOf', 'description']);

export function toProviderSchema(schema, { dropAdditionalProperties = false } = {}) {
  if (Array.isArray(schema)) return schema.map(s => toProviderSchema(s, { dropAdditionalProperties }));
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (LOCAL_ONLY.has(k) || (dropAdditionalProperties && k === 'additionalProperties')) continue;
    if (k === 'properties') out[k] = Object.fromEntries(Object.entries(v).map(([p, s]) => [p, toProviderSchema(s, { dropAdditionalProperties })]));
    else out[k] = typeof v === 'object' ? toProviderSchema(v, { dropAdditionalProperties }) : v;
  }
  return out;
}

export function parseStructured(text, schema, provider) {
  const cleaned = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let value;
  try { value = JSON.parse(cleaned); }
  catch { throw new AIError(`${provider} returned invalid JSON`, { kind: 'invalid_output', provider }); }
  const errors = validate(schema, value);
  if (errors.length) throw new AIError(`${provider} output failed validation: ${errors.slice(0, 3).join('; ')}`, { kind: 'invalid_output', provider });
  return value;
}
