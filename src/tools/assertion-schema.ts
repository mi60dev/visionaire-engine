/**
 * Shared assertion zod schemas — the single source of truth for assert_visual
 * and responsive_sweep. These used to be duplicated in both tools and drifted
 * (the sweep copy typed params.value as number-only, rejecting the CSS color
 * strings that color_equals/color_near take), so both tools import from here.
 */
import { z } from 'zod'

export const targetSchema = z.union([
  z.string().describe('Element uid from a prior page_snapshot / find_elements'),
  z
    .object({ selector: z.string() })
    .describe('CSS selector — expands to ALL matches (>40 matches is TARGET_AMBIGUOUS; narrow the selector)'),
  z.object({ role: z.string(), name: z.string().optional() }).describe('ARIA role (+ exact accessible name)'),
])

export const assertionSchema = z.object({
  id: z.string().max(80).optional().describe('Caller label, echoed back in the result'),
  type: z
    .string()
    .describe(
      'One of: equal_height, equal_width, aligned_edges, centered, gap_equals, spacing_equals, visible, ' +
        'not_clipped, not_overlapped, within_viewport, color_equals, color_near, z_above, text_not_truncated, ' +
        'text_not_overflowing, size_equals, positioned',
    ),
  targets: z.array(targetSchema).min(1).describe('Target elements; selector/role entries expand to all matches'),
  params: z
    .object({
      edge: z.enum(['left', 'right', 'top', 'bottom']).optional(),
      in: z.enum(['parent', 'viewport']).optional(),
      axis: z.enum(['x', 'y', 'both']).optional(),
      value: z
        .union([z.number(), z.string()])
        .optional()
        .describe('gap_equals: expected gap in px (number); color_equals/color_near: expected CSS color (string)'),
      fully: z.boolean().optional(),
      property: z.enum(['text', 'background', 'border']).optional(),
      deltaE: z.number().min(0).optional(),
      by: targetSchema
        .optional()
        .describe('not_overlapped: restrict the occlusion check to these element(s); ignored by other types'),
      relation: z.enum(['left_of', 'right_of', 'above', 'below', 'inside', 'contains']).optional(),
      width_px: z.number().optional(),
      height_px: z.number().optional(),
    })
    .optional()
    .describe('Per-type parameters (see the type list in docs/tools.md)'),
  tolerance_px: z.number().min(0).max(100).optional().describe('Per-assertion tolerance override'),
})
