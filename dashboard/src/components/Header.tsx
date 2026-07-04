import { useEffect, useState } from "react";

function readTheme(): "light" | "dark" {
  return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
}

export function Header({ repoKey, generatedAt }: { repoKey: string; generatedAt: string }) {
  const [theme, setTheme] = useState(readTheme());

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("cd-theme", theme);
  }, [theme]);

  return (
    <header
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "10px 20px",
        borderBottom: "1px solid var(--border)",
        background: "var(--surface)"
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
        <strong style={{ fontSize: 15 }}>commons-devloop</strong>
        <span style={{ color: "var(--text-muted)", fontSize: 13 }}>{repoKey}</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
          Updated {new Date(generatedAt).toLocaleTimeString()}
        </span>
        <button
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          style={{ background: "var(--surface-alt)", border: "1px solid var(--border)", borderRadius: 6, padding: "4px 8px" }}
        >
          {theme === "dark" ? "Light mode" : "Dark mode"}
        </button>
      </div>
    </header>
  );
}
