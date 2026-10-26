/**
 * Minimal, zero-dependency JSON Schema validator.
 *
 * Supports exactly the keyword subset used by the two AEE schemas
 * (`aee-v1.schema.json` and `decision-evidence.schema.json`):
 *   type (string | string[]), const, enum, minLength, minimum, maximum,
 *   required, properties, additionalProperties (boolean), items, allOf,
 *   if/then/else.
 *
 * This keeps the SDK core dependency-free while remaining genuinely
 * schema-backed: it evaluates the schema document itself, so the same JSON
 * file that is the cross-language contract is what drives validation. It is
 * NOT a general-purpose JSON Schema engine.
 */

export type JsonSchema = Record<string, unknown>

export interface ValidationResult {
  valid: boolean
  errors: string[]
}

function jsonType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  const t = typeof value
  if (t === 'number') return Number.isInteger(value) ? 'integer' : 'number'
  return t
}

function matchesType(value: unknown, expected: string): boolean {
  const actual = jsonType(value)
  if (expected === 'number') return actual === 'number' || actual === 'integer'
  if (expected === 'object') return actual === 'object'
  return actual === expected
}

function typeOk(value: unknown, type: string | string[]): boolean {
  const types = Array.isArray(type) ? type : [type]
  return types.some((t) => matchesType(value, t))
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a && b && typeof a === 'object') {
    return JSON.stringify(a) === JSON.stringify(b)
  }
  return false
}

/** Does `value` satisfy `schema`? Used for if/then conditionals (no error output). */
function satisfies(schema: JsonSchema, value: unknown): boolean {
  return validateNode(schema, value, '').valid
}

function validateNode(schema: JsonSchema, value: unknown, path: string): ValidationResult {
  const errors: string[] = []
  const at = path || '(root)'

  if ('type' in schema) {
    if (!typeOk(value, schema.type as string | string[])) {
      errors.push(`${at}: expected type ${JSON.stringify(schema.type)}, got ${jsonType(value)}`)
      // Type mismatch, further keyword checks would be noise.
      return { valid: false, errors }
    }
  }

  if ('const' in schema && !deepEqual(value, schema.const)) {
    errors.push(`${at}: must equal ${JSON.stringify(schema.const)}`)
  }

  if ('enum' in schema && Array.isArray(schema.enum)) {
    if (!schema.enum.some((e) => deepEqual(value, e))) {
      errors.push(`${at}: must be one of ${JSON.stringify(schema.enum)}`)
    }
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      errors.push(`${at}: string shorter than minLength ${schema.minLength}`)
    }
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      errors.push(`${at}: ${value} is below minimum ${schema.minimum}`)
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      errors.push(`${at}: ${value} is above maximum ${schema.maximum}`)
    }
  }

  if (Array.isArray(value) && schema.items && typeof schema.items === 'object') {
    value.forEach((item, i) => {
      const r = validateNode(schema.items as JsonSchema, item, `${at}[${i}]`)
      errors.push(...r.errors)
    })
  }

  if (jsonType(value) === 'object') {
    const obj = value as Record<string, unknown>
    const props = (schema.properties as Record<string, JsonSchema>) || {}

    if (Array.isArray(schema.required)) {
      for (const key of schema.required as string[]) {
        if (!(key in obj)) errors.push(`${at}: missing required property "${key}"`)
      }
    }

    for (const [key, val] of Object.entries(obj)) {
      if (key in props) {
        const r = validateNode(props[key], val, path ? `${path}.${key}` : key)
        errors.push(...r.errors)
      } else if (schema.additionalProperties === false) {
        errors.push(`${at}: additional property "${key}" is not allowed`)
      }
    }
  }

  if (Array.isArray(schema.allOf)) {
    for (const sub of schema.allOf as JsonSchema[]) {
      // if/then/else within an allOf entry.
      if ('if' in sub) {
        const condition = sub.if as JsonSchema
        if (satisfies(condition, value)) {
          if (sub.then) {
            const r = validateNode(sub.then as JsonSchema, value, path)
            errors.push(...r.errors)
          }
        } else if (sub.else) {
          const r = validateNode(sub.else as JsonSchema, value, path)
          errors.push(...r.errors)
        }
      } else {
        const r = validateNode(sub, value, path)
        errors.push(...r.errors)
      }
    }
  }

  return { valid: errors.length === 0, errors }
}

/** Validates `value` against `schema`, returning `{ valid, errors[] }`. */
export function validateAgainstSchema(schema: JsonSchema, value: unknown): ValidationResult {
  return validateNode(schema, value, '')
}
