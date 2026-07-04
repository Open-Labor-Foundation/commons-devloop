import { useState, type ReactNode } from "react";

export function Panel({
  title,
  children,
  actions,
  defaultCollapsed,
  id
}: {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
  defaultCollapsed?: boolean;
  id?: string;
}) {
  const storageKey = id ? `cd-panel-collapsed-${id}` : null;
  const [collapsed, setCollapsed] = useState(() => {
    if (storageKey) {
      const stored = localStorage.getItem(storageKey);
      if (stored != null) return stored === "1";
    }
    return Boolean(defaultCollapsed);
  });

  function toggle() {
    setCollapsed((prev) => {
      const next = !prev;
      if (storageKey) localStorage.setItem(storageKey, next ? "1" : "0");
      return next;
    });
  }

  return (
    <section
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        boxShadow: "var(--shadow)",
        marginBottom: 16
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "10px 14px",
          borderBottom: collapsed ? "none" : "1px solid var(--border)"
        }}
      >
        <button
          onClick={toggle}
          aria-expanded={!collapsed}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            background: "none",
            border: "none",
            padding: 0,
            font: "inherit",
            color: "var(--text)",
            cursor: "pointer"
          }}
        >
          <span
            aria-hidden="true"
            style={{
              display: "inline-block",
              transition: "transform 0.15s ease",
              transform: collapsed ? "rotate(-90deg)" : "rotate(0deg)",
              fontSize: 10,
              color: "var(--text-muted)"
            }}
          >
            &#9660;
          </span>
          <h2 style={{ fontSize: 14, margin: 0, fontWeight: 600 }}>{title}</h2>
        </button>
        {actions}
      </div>
      {!collapsed && <div style={{ padding: 14 }}>{children}</div>}
    </section>
  );
}

const TONE_COLORS: Record<string, string> = {
  good: "var(--good)",
  warn: "var(--warn)",
  bad: "var(--bad)"
};

export function Badge({ tone, children, title }: { tone: "good" | "warn" | "bad" | string; children: ReactNode; title?: string }) {
  return (
    <span
      title={title}
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 600,
        color: "#fff",
        background: TONE_COLORS[tone] ?? "var(--text-muted)"
      }}
    >
      {children}
    </span>
  );
}

export function Button({
  children,
  onClick,
  variant = "default",
  disabled,
  type = "button"
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "default" | "primary" | "danger";
  disabled?: boolean;
  type?: "button" | "submit";
}) {
  const background = variant === "primary" ? "var(--accent)" : variant === "danger" ? "var(--bad)" : "var(--surface-alt)";
  const color = variant === "default" ? "var(--text)" : "var(--accent-contrast)";
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      style={{
        background,
        color,
        border: "1px solid var(--border)",
        borderRadius: 6,
        padding: "5px 10px",
        fontSize: 13,
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? "not-allowed" : "pointer"
      }}
    >
      {children}
    </button>
  );
}

export function Tabs({
  tabs,
  active,
  onChange
}: {
  tabs: Array<{ key: string; label: string }>;
  active: string;
  onChange: (key: string) => void;
}) {
  return (
    <div role="tablist" style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
      {tabs.map((tab) => (
        <button
          key={tab.key}
          role="tab"
          aria-selected={active === tab.key}
          onClick={() => onChange(tab.key)}
          style={{
            background: active === tab.key ? "var(--accent)" : "var(--surface-alt)",
            color: active === tab.key ? "var(--accent-contrast)" : "var(--text)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            padding: "4px 10px",
            fontSize: 12,
            cursor: "pointer"
          }}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export function Metric({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div>
      <div style={{ color: "var(--text-muted)", fontSize: 11 }}>{label}</div>
      <div style={{ fontSize: 13 }}>{value}</div>
      {sub && (
        <div style={{ color: "var(--text-muted)", fontSize: 11 }}>{sub}</div>
      )}
    </div>
  );
}
