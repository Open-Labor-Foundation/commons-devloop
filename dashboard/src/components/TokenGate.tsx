import { useState } from "react";
import { setStoredToken } from "../api";

export function TokenGate({ onSubmit }: { onSubmit: () => void }) {
  const [value, setValue] = useState("");

  return (
    <div style={{ display: "flex", height: "100vh", alignItems: "center", justifyContent: "center" }}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setStoredToken(value.trim());
          onSubmit();
        }}
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          padding: 24,
          width: 360,
          boxShadow: "var(--shadow)"
        }}
      >
        <h1 style={{ fontSize: 16, marginTop: 0 }}>commons-devloop</h1>
        <p style={{ color: "var(--text-muted)", fontSize: 13 }}>
          This dashboard requires a bearer token (AE_DASHBOARD_TOKEN on the host).
        </p>
        <input
          type="password"
          autoFocus
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="Dashboard token"
          style={{ width: "100%", marginBottom: 12 }}
        />
        <button
          type="submit"
          style={{
            width: "100%",
            background: "var(--accent)",
            color: "var(--accent-contrast)",
            border: "none",
            borderRadius: 6,
            padding: "8px 0",
            fontWeight: 600
          }}
        >
          Continue
        </button>
      </form>
    </div>
  );
}
