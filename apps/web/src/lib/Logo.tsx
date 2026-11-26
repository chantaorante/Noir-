export function Logo({ size = 28, withWord = false }: { size?: number; withWord?: boolean }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
      <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
        <defs>
          <linearGradient id="lg-gold" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#ecd6a6" /><stop offset="1" stopColor="#a8884f" /></linearGradient>
        </defs>
        <rect x="3" y="3" width="42" height="42" rx="10" fill="#101113" stroke="url(#lg-gold)" strokeWidth="1.5" />
        <path d="M24 10c-4 5.5-11 9-11 15.2 0 3.8 3 6.4 6.3 6.4 1.9 0 3.4-.8 4.2-2-.4 3.2-1.6 5.6-3.8 7.4h8.6c-2.2-1.8-3.4-4.2-3.8-7.4.8 1.2 2.3 2 4.2 2 3.3 0 6.3-2.6 6.3-6.4C35 19 28 15.5 24 10z" fill="url(#lg-gold)" />
      </svg>
      {withWord && <span className="display" style={{ fontSize: size * 0.8, letterSpacing: '0.28em', color: 'var(--gold-strong)' }}>NOIR</span>}
    </span>
  );
}
