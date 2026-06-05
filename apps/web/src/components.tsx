import type { ReactNode } from "react";

export function Panel({
  title,
  children,
  span = 12,
}: {
  title?: string;
  children: ReactNode;
  span?: 4 | 6 | 8 | 12;
}): ReactNode {
  return (
    <section className="panel" data-span={span}>
      {title ? <h3>{title}</h3> : null}
      {children}
    </section>
  );
}

export function StatCard({
  label,
  value,
  detail,
}: {
  label: string;
  value: string | number;
  detail?: string;
}): ReactNode {
  return (
    <div className="panel" data-span="4">
      <div className="kpi">
        <div className="value">{value}</div>
        <div className="label">{label}</div>
        {detail ? <div className="tiny">{detail}</div> : null}
      </div>
    </div>
  );
}

export function KeyValueList({
  items,
}: {
  items: Array<[string, ReactNode]>;
}): ReactNode {
  return (
    <div className="list">
      {items.map(([label, value]) => (
        <div className="list-item" key={label}>
          <div className="tiny">{label}</div>
          <div>{value}</div>
        </div>
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  body,
  actionLabel,
  onAction,
}: {
  title: string;
  body: string;
  actionLabel?: string;
  onAction?: () => void;
}): ReactNode {
  return (
    <div className="list-item">
      <strong>{title}</strong>
      <div className="tiny">{body}</div>
      {actionLabel && onAction ? (
        <div className="row" style={{ marginTop: "0.4rem" }}>
          <button type="button" onClick={onAction}>{actionLabel}</button>
        </div>
      ) : null}
    </div>
  );
}

export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "good" | "warn" | "bad";
}): ReactNode {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}
