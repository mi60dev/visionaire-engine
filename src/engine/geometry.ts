/**
 * Rendered-pixel / glyph geometry — the deterministic answer to "is this glyph
 * actually centered?". Two pieces:
 *
 *   1. measureExpression() — a Runtime.callFunctionOn(this=element) function that
 *      returns, using ONLY web APIs, the element's *content-box* rect (rect minus
 *      padding + border via getComputedStyle) and the *text ink* bounding box of
 *      its text (canvas 2d measureText actualBoundingBox* metrics — the true glyph
 *      ink extents, exactly what a hand-rolled CDP+canvas harness computes),
 *      anchored to the text's real painted position via a Range rect.
 *
 *   2. centeringDeltas() — pure arithmetic over those raw numbers: how far the ink
 *      center sits from the content-box center on each axis, with a human fix hint.
 *      Unit-tested without a browser.
 *
 * Empirically verified against headless Chrome (see the probe scripts in the build
 * notes): for the glyph "×" in 16px Arial in a 32×32 padded button, the canvas ink
 * center and the DOM Range center agree to sub-pixel (1197.67px), and the baseline
 * derived as rangeTop + fontBoundingBoxAscent reproduces the painted vertical ink
 * box to <0.1px. actualBoundingBoxDescent can be NEGATIVE (ink entirely above the
 * baseline, e.g. "×"), so ink height is ascent+descent and may legitimately shrink.
 */

/** Content-box rect in viewport CSS px (getBoundingClientRect minus padding + border). */
export interface ContentBox {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Text ink metrics from canvas measureText, plus the painted anchor from a DOM
 * Range. All numbers are raw (no rounding) so the pure layer can do exact math.
 *  - textLeft / baseline: the pen origin of the laid-out text in viewport px.
 *  - left/right: actualBoundingBox horizontal extents from the pen (px).
 *  - ascent/descent: actualBoundingBox vertical extents from the baseline (px).
 */
export interface InkMetrics {
  /** Viewport x of the text pen origin (Range left edge; textAlign is normalized to left in-page). */
  textLeft: number
  /** Viewport y of the alphabetic baseline (Range top + fontBoundingBoxAscent). */
  baseline: number
  left: number
  right: number
  ascent: number
  descent: number
  /** measureText().width — the advance width, for reference. */
  advance: number
  /** True when the element has no non-whitespace text to measure. */
  empty: boolean
}

/** Raw payload returned by measureExpression()'s in-page function (returnByValue). */
export interface MeasurePayload {
  content: ContentBox
  ink: InkMetrics
  /** Rendered font shorthand used for measurement, e.g. "16px / 16px Arial". */
  font: string
  /** Human-friendly "16px \"Arial\"" for display. */
  fontShort: string
  /** Raw text content (caller sanitizes before output). */
  text: string
}

/**
 * The in-page measurement function, as a source string for
 * Runtime.callFunctionOn({ objectId, returnByValue: true }) with the element as
 * `this`. Uses only web APIs (getComputedStyle, getBoundingClientRect, Range,
 * canvas 2d measureText). Returns raw numbers — no formatting, no rounding.
 *
 * Vanilla ES5-in-string style to match the other engine expressions; safe under
 * returnByValue (only plain numbers/strings cross the boundary).
 */
export function measureExpression(): string {
  return `function () {
  var cs = getComputedStyle(this);
  var num = function (v) { var n = parseFloat(v); return isFinite(n) ? n : 0; };
  var rect = this.getBoundingClientRect();
  var bl = num(cs.borderLeftWidth), br = num(cs.borderRightWidth);
  var bt = num(cs.borderTopWidth), bb = num(cs.borderBottomWidth);
  var pl = num(cs.paddingLeft), pr = num(cs.paddingRight);
  var pt = num(cs.paddingTop), pb = num(cs.paddingBottom);
  var content = {
    x: rect.left + bl + pl,
    y: rect.top + bt + pt,
    width: rect.width - bl - br - pl - pr,
    height: rect.height - bt - bb - pt - pb,
  };

  // Rendered font. cs.font may be empty on some elements — rebuild from longhands.
  var font = cs.font;
  if (!font) {
    font = (cs.fontStyle + ' ' + cs.fontVariant + ' ' + cs.fontWeight + ' ' +
            cs.fontSize + '/' + cs.lineHeight + ' ' + cs.fontFamily);
  }
  var fam = (cs.fontFamily || '').split(',')[0].replace(/^\\s*["']?|["']?\\s*$/g, '');
  var fontShort = cs.fontSize + ' "' + fam + '"';

  var text = this.textContent == null ? '' : String(this.textContent);
  var trimmed = text.replace(/\\s+/g, ' ').trim();

  var ink = {
    textLeft: 0, baseline: 0, left: 0, right: 0, ascent: 0, descent: 0,
    advance: 0, empty: trimmed.length === 0,
  };
  if (!ink.empty) {
    // Painted anchor: the Range around the text node(s) gives the real laid-out
    // line box in viewport px (respects the element's own text-align, padding, etc.).
    var range = document.createRange();
    range.selectNodeContents(this);
    var rr = range.getBoundingClientRect();

    var canvas = document.createElement('canvas');
    var g = canvas.getContext('2d');
    g.font = font;
    g.textBaseline = 'alphabetic';
    g.textAlign = 'left';
    var m = g.measureText(trimmed);

    // Pen origin x = Range left. For textAlign other than left the glyph may be
    // shifted inside the line box, but the Range rect already reflects the painted
    // position, so left edge of the line box is the correct horizontal anchor.
    ink.textLeft = rr.left;
    // Baseline = line-box top + font ascent (font metrics, not ink) — reproduces
    // the painted baseline to sub-pixel (verified).
    ink.baseline = rr.top + (typeof m.fontBoundingBoxAscent === 'number' ? m.fontBoundingBoxAscent : num(cs.fontSize) * 0.8);
    ink.left = m.actualBoundingBoxLeft;
    ink.right = m.actualBoundingBoxRight;
    ink.ascent = m.actualBoundingBoxAscent;
    ink.descent = m.actualBoundingBoxDescent;
    ink.advance = m.width;
  }

  return { content: content, ink: ink, font: font, fontShort: fontShort, text: text };
}`
}

/** Absolute viewport extents of the text ink box, derived from raw InkMetrics. */
export interface InkBox {
  left: number
  right: number
  top: number
  bottom: number
  width: number
  height: number
  centerX: number
  centerY: number
}

/**
 * Resolve the raw canvas/Range metrics into an absolute ink box (viewport px).
 * actualBoundingBoxLeft is measured leftward from the pen, so absolute ink left =
 * textLeft - left. Vertically, ink spans [baseline - ascent, baseline + descent]
 * (descent may be negative → ink sits above the baseline).
 */
export function inkBox(ink: InkMetrics): InkBox {
  const left = ink.textLeft - ink.left
  const right = ink.textLeft + ink.right
  const top = ink.baseline - ink.ascent
  const bottom = ink.baseline + ink.descent
  return {
    left,
    right,
    top,
    bottom,
    width: right - left,
    height: bottom - top,
    centerX: (left + right) / 2,
    centerY: (top + bottom) / 2,
  }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

/** Center of a content box on both axes. */
function boxCenter(box: ContentBox): { x: number; y: number } {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

export interface CenteringResult {
  /** ink centerX − box centerX. Positive → ink sits right of center. */
  horizontal: number
  /** ink centerY − box centerY. Positive → ink sits below center. */
  vertical: number
  /** One-line human hint with the fix direction and magnitude. */
  hint: string
}

const EPS = 0.5

/**
 * Pure centering math: how far the text-ink center is from the content-box center
 * on each axis, plus a human hint pointing at the fix. Both deltas are
 * ink-center − box-center, so positive-horizontal = ink right of center and
 * positive-vertical = ink below center. Rounded to 0.1px for output.
 *
 * Sub-|EPS|px on an axis is reported as centered ("~0"). The hint names the
 * off-center axis (or both), the direction, and the typical lever (padding /
 * line-height), matching the hand-rolled harness the field report described.
 */
export function centeringDeltas(box: ContentBox, ink: InkBox): CenteringResult {
  const c = boxCenter(box)
  const horizontal = round1(ink.centerX - c.x)
  const vertical = round1(ink.centerY - c.y)

  const hParts: string[] = []
  if (Math.abs(horizontal) >= EPS) {
    const side = horizontal > 0 ? 'right' : 'left'
    const shift = horizontal > 0 ? 'left' : 'right'
    const mag = Math.abs(horizontal)
    hParts.push(
      `ink center ${mag}px ${side} of box center → shift content ${shift} ${mag}px ` +
        `(e.g. adjust padding-${shift === 'left' ? 'left' : 'right'})`,
    )
  }
  if (Math.abs(vertical) >= EPS) {
    const side = vertical > 0 ? 'below' : 'above'
    const shift = vertical > 0 ? 'up' : 'down'
    const mag = Math.abs(vertical)
    hParts.push(
      `ink center ${mag}px ${side} box center → nudge ${shift} ${mag}px ` +
        `(e.g. adjust line-height / padding-${vertical > 0 ? 'bottom' : 'top'})`,
    )
  }

  const hint = hParts.length > 0 ? hParts.join('; ') : 'text ink is centered in the content box (both axes within 0.5px)'
  return { horizontal, vertical, hint }
}
