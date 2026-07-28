import { useId } from 'react'

/**
 * The i3X emblem, rebuilt as live geometry and animated as the app's large
 * loading state. The mark is two ruled sheets of interpolated cubic curves
 * inside a glowing ring:
 *
 *  - the WING sweeps from the left rim over the top and wraps into a vortex
 *    "eye" at the upper right — each line's endpoint sits on a spiral around
 *    the eye and arrives tangentially, which is what makes the curl read;
 *  - the HILL rises from the lower left, crests mid-emblem, dips, and climbs
 *    into the fan under the eye, splaying to the lower-right rim.
 *
 * Line spacing is cosine-clustered toward each sheet's edges and opacity is
 * brightest there, mimicking the fold "caustics" of the original artwork. The
 * whole drawing uses the theme's green→blue accents (the logo's own palette)
 * via a shared userSpaceOnUse gradient, so every line is colored by where it
 * sits in the emblem, not per path.
 *
 * The loading animation lives in `styles/index.css` (`.i3x-loader-*`): mesh
 * lines perpetually draw in, hold, and sweep out, staggered across each sheet
 * (negative inline delays start it mid-weave, so it never pops in empty); a
 * blurred static copy underneath keeps the emblem visible between passes, and
 * a bright arc chases around the ring. Reduced motion freezes it fully drawn —
 * pair the loader with a text label that carries the state.
 *
 * Use for surface-level loads (tree, overview, graphs); inline and button
 * loads use the plain `Spinner`.
 */

type Pt = [number, number]

const D2R = Math.PI / 180
const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const lerpPt = (p: Pt, q: Pt, t: number): Pt => [lerp(p[0], q[0], t), lerp(p[1], q[1], t)]

/** Cosine spacing: clusters samples near t=0 and t=1, the sheet's bright folds. */
const cluster = (t: number) => (1 - Math.cos(Math.PI * t)) / 2

/** Dim mid-sheet, bright at both folds. */
const edgeOpacity = (t: number) => 0.2 + 0.8 * Math.pow(Math.abs(2 * t - 1), 1.4)

const cubic = (p0: Pt, c1: Pt, c2: Pt, p3: Pt) =>
  `M${p0[0].toFixed(1)} ${p0[1].toFixed(1)}C${c1[0].toFixed(1)} ${c1[1].toFixed(1)} ${c2[0].toFixed(1)} ${c2[1].toFixed(1)} ${p3[0].toFixed(1)} ${p3[1].toFixed(1)}`

/** The vortex "eye" the wing wraps into. */
const EYE: Pt = [72, 29]

// Guide pairs [inner, outer]: each sheet interpolates between its two guides.
const WING_START: [Pt, Pt] = [[10, 52], [7, 63]]
const WING_CTRL: [Pt, Pt] = [[30, 34], [-6, 4]]
const HILL_INNER: [Pt, Pt, Pt, Pt] = [[9, 63], [36, 31], [62, 54], [75, 35]]
const HILL_OUTER: [Pt, Pt, Pt, Pt] = [[13, 75], [32, 94], [68, 94], [84, 76]]

interface MeshLine {
  d: string
  opacity: number
  /** Stagger of the weave animation, seconds (applied as a negative delay). */
  delay: number
}

function buildMesh(nWing: number, nHill: number): MeshLine[] {
  const lines: MeshLine[] = []

  for (let i = 0; i < nWing; i++) {
    const t = cluster(i / (nWing - 1))
    const p0 = lerpPt(WING_START[0], WING_START[1], t)
    const c1 = lerpPt(WING_CTRL[0], WING_CTRL[1], t)
    // Endpoint on a spiral around the eye; the last control point pulls the
    // curve in along the spiral's tangent so the lines wrap, not just meet.
    const phi = lerp(150, -78, t) * D2R
    const radius = lerp(3, 20, t)
    const p3: Pt = [EYE[0] + radius * Math.cos(phi), EYE[1] + radius * Math.sin(phi)]
    const reach = lerp(12, 26, t)
    const c2: Pt = [p3[0] - Math.sin(phi) * reach, p3[1] + Math.cos(phi) * reach]
    lines.push({ d: cubic(p0, c1, c2, p3), opacity: edgeOpacity(t), delay: t })
  }

  for (let i = 0; i < nHill; i++) {
    const t = cluster(i / (nHill - 1))
    const [p0, c1, c2, p3] = HILL_INNER.map((p, k) => lerpPt(p, HILL_OUTER[k], t))
    // Offset by half a beat so the two sheets weave alternately, not in step.
    lines.push({ d: cubic(p0, c1, c2, p3), opacity: edgeOpacity(t), delay: 0.55 + t })
  }

  return lines
}

// Two precomputed detail levels: hairlines for large surfaces, fewer/thicker
// lines below 64px where 66 hairlines would alias into mush.
const FULL = { lines: buildMesh(34, 32), strokeWidth: 0.45 }
const COMPACT = { lines: buildMesh(17, 16), strokeWidth: 0.85 }

export function I3xLoader({ size = 56, className = '' }: { size?: number; className?: string }) {
  const uid = useId()
  const gradId = `${uid}-grad`
  const glowId = `${uid}-glow`
  const hazeId = `${uid}-haze`
  const stroke = `url(#${gradId})`
  const { lines, strokeWidth } = size >= 64 ? FULL : COMPACT

  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      strokeLinecap="round"
      className={`shrink-0 ${className}`}
    >
      <defs>
        <linearGradient id={gradId} gradientUnits="userSpaceOnUse" x1="40" y1="0" x2="62" y2="100">
          <stop offset="0%" stopColor="rgb(var(--i3x-success))" />
          <stop offset="38%" stopColor="rgb(var(--i3x-success))" />
          <stop offset="100%" stopColor="rgb(var(--i3x-primary))" />
        </linearGradient>
        {/* userSpaceOnUse regions so the blurs scale with the emblem */}
        <filter id={glowId} filterUnits="userSpaceOnUse" x="-20" y="-20" width="140" height="140">
          <feGaussianBlur stdDeviation="2.6" />
        </filter>
        <filter id={hazeId} filterUnits="userSpaceOnUse" x="-20" y="-20" width="140" height="140">
          <feGaussianBlur stdDeviation="1.4" />
        </filter>
      </defs>

      {/* Halo behind the ring */}
      <circle
        cx="50"
        cy="50"
        r="47"
        stroke={stroke}
        strokeWidth="5"
        opacity="0.5"
        filter={`url(#${glowId})`}
      />

      {/* Static hazy ghost of the mesh, so the emblem never vanishes mid-weave */}
      <g filter={`url(#${hazeId})`} opacity="0.55">
        {lines.map((line, i) => (
          <path key={i} d={line.d} stroke={stroke} strokeWidth={strokeWidth} opacity={line.opacity} />
        ))}
      </g>

      {/* The weaving mesh */}
      <g className="i3x-loader-mesh">
        {lines.map((line, i) => (
          <path
            key={i}
            d={line.d}
            stroke={stroke}
            strokeWidth={strokeWidth}
            opacity={line.opacity}
            pathLength={100}
            style={{ animationDelay: `${-line.delay}s` }}
          />
        ))}
      </g>

      {/* Ring: faint base circle plus the chasing bright arc */}
      <circle cx="50" cy="50" r="47" stroke={stroke} strokeWidth="2.2" opacity="0.4" />
      <circle
        className="i3x-loader-ring"
        cx="50"
        cy="50"
        r="47"
        stroke={stroke}
        strokeWidth="2.2"
        pathLength={100}
      />
    </svg>
  )
}
