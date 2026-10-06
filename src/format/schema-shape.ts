/**
 * One-line TypeScript-ish rendering of a zod schema, for argument errors (field report
 * 2026-10-06: `page_snapshot` rejected `scope: "<string>"` with "expected object, received
 * string" and never said what object it wanted).
 */
import { z } from 'zod'

const MAX_DEPTH = 3

export function describeShape(schema: z.ZodTypeAny, depth = 0): string {
  const def = schema._def as { typeName?: string }
  switch (def.typeName) {
    case 'ZodOptional':
    case 'ZodNullable':
    case 'ZodDefault':
      return describeShape((schema._def as { innerType: z.ZodTypeAny }).innerType, depth)
    case 'ZodEffects':
      return describeShape((schema._def as { schema: z.ZodTypeAny }).schema, depth)
    case 'ZodString':
      return 'string'
    case 'ZodNumber':
      return 'number'
    case 'ZodBoolean':
      return 'boolean'
    case 'ZodLiteral':
      return JSON.stringify((schema._def as { value: unknown }).value)
    case 'ZodEnum':
      return (schema._def as { values: string[] }).values.map((v) => JSON.stringify(v)).join(' | ')
    case 'ZodArray':
      return `${describeShape((schema._def as { type: z.ZodTypeAny }).type, depth + 1)}[]`
    case 'ZodUnion':
      return (schema._def as { options: z.ZodTypeAny[] }).options.map((o) => describeShape(o, depth + 1)).join(' | ')
    case 'ZodRecord':
      return `Record<string, ${describeShape((schema._def as { valueType: z.ZodTypeAny }).valueType, depth + 1)}>`
    case 'ZodObject': {
      if (depth >= MAX_DEPTH) return '{…}'
      const shape = (schema as z.ZodObject<z.ZodRawShape>).shape
      const fields = Object.entries(shape).map(([k, v]) => `${k}${v.isOptional() ? '?' : ''}: ${describeShape(v, depth + 1)}`)
      return `{ ${fields.join(', ')} }`
    }
    default:
      return 'any'
  }
}

/** The sub-schema at an issue path inside a raw shape, or undefined when the path leaves it. */
export function schemaAt(shape: z.ZodRawShape, path: Array<string | number>): z.ZodTypeAny | undefined {
  let cur: z.ZodTypeAny | undefined = z.object(shape)
  for (const key of path) {
    while (cur && ['ZodOptional', 'ZodNullable', 'ZodDefault'].includes((cur._def as { typeName?: string }).typeName ?? '')) {
      cur = (cur._def as { innerType: z.ZodTypeAny }).innerType
    }
    if (!cur) return undefined
    const tn = (cur._def as { typeName?: string }).typeName
    if (tn === 'ZodObject' && typeof key === 'string') cur = (cur as z.ZodObject<z.ZodRawShape>).shape[key]
    else if (tn === 'ZodArray' && typeof key === 'number') cur = (cur._def as { type: z.ZodTypeAny }).type
    else return undefined
  }
  return cur
}
