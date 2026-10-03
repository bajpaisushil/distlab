export function StatTile({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: 'good' | 'warning' | 'serious' | 'critical';
}) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub ? (
        <div className={`stat-sub${tone ? ` status-${tone}` : ''}`} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          {tone ? <span className="dot status-dot" /> : null}
          {sub}
        </div>
      ) : null}
    </div>
  );
}
