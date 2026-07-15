import type { ReactNode } from 'react'

/** Card, the panel surface every detail section sits on. */
export function Card({
  title,
  actions,
  children,
  className = '',
}: {
  title?: ReactNode
  /** Right-aligned controls in the card header (toggles, refresh, counts). */
  actions?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={`bg-i3x-surface border border-i3x-border rounded-xl p-4 ${className}`}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 mb-3">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-i3x-text-muted">
            {title}
          </h3>
          {actions && <div className="flex items-center gap-3">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  )
}

/** Labeled, monospaced, single-line value box. Full text lives in the tooltip. */
export function Field({ label, value }: { label: string; value: string | null | undefined }) {
  const isEmpty = value == null || value === ''
  const shown = isEmpty ? '—' : value

  return (
    <div className="min-w-0">
      <label className="block text-[11.5px] text-i3x-text-muted mb-1.5">{label}</label>
      <div
        title={isEmpty ? undefined : shown}
        className={`font-mono text-[13px] bg-i3x-bg border border-i3x-border rounded-lg px-3 py-2 truncate ${
          isEmpty ? 'text-i3x-text-muted' : 'text-i3x-text'
        }`}
      >
        {shown}
      </div>
    </div>
  )
}

/** Pill-style exclusive choice, e.g. Parsed / Raw. */
export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (value: T) => void
  /** Accessible group name, not rendered. */
  label: string
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="flex items-center gap-0.5 bg-i3x-bg border border-i3x-border rounded-lg p-0.5"
    >
      {options.map(option => {
        const active = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            className={`px-3 py-1 text-[11.5px] rounded-md transition-colors motion-reduce:transition-none focus:outline-none focus-visible:ring-2 focus-visible:ring-i3x-primary ${
              active
                ? 'bg-i3x-surface text-i3x-primary font-medium shadow-sm'
                : 'text-i3x-text-muted hover:text-i3x-text'
            }`}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
