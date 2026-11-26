export function Logo({ size = 28, withWord = false }: { size?: number; withWord?: boolean }) {
  return (
    <span className="logo" style={{ display: 'inline-flex', alignItems: 'center', gap: 12 }}>
      <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
        <defs>
          <linearGradient id="lg-emerald" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#5fe3a8" /><stop offset="1" stopColor="#1f9e69" /></linearGradient>
        </defs>
        <rect x="1" y="1" width="46" height="46" rx="12" fill="url(#lg-emerald)" />
        <path d="M24 11c-4 5.2-10.5 8.6-10.5 14.4 0 3.6 2.9 6.1 6 6.1 1.8 0 3.2-.8 4-1.9-.4 3-1.5 5.3-3.6 7h8.2c-2.1-1.7-3.2-4-3.6-7 .8 1.1 2.2 1.9 4 1.9 3.1 0 6-2.5 6-6.1C34.5 19.6 28 16.2 24 11z" fill="#06130e" />
      </svg>
      {withWord && (
        <span style={{ display: 'grid', lineHeight: 1.1 }}>
          <span style={{ fontWeight: 750, letterSpacing: '0.22em', fontSize: size * 0.5, color: 'var(--text)' }}>NOIR POKER</span>
          <span className="label" style={{ fontSize: Math.max(9, size * 0.3), letterSpacing: '0.22em' }}>Private club</span>
        </span>
      )}
    </span>
  );
}
