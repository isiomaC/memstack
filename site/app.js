(() => {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---- reveal on scroll ----
  const reveals = document.querySelectorAll(".reveal");
  if (!reduce && "IntersectionObserver" in window) {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { e.target.classList.add("is-in"); io.unobserve(e.target); }
    }, { rootMargin: "0px 0px -8% 0px" });
    reveals.forEach((el) => io.observe(el));
  } else {
    reveals.forEach((el) => el.classList.add("is-in"));
  }

  // ---- tabs ----
  document.querySelectorAll("[data-tabs]").forEach((root) => {
    const tabs = [...root.querySelectorAll('[role="tab"]')];
    const select = (tab, focus) => {
      tabs.forEach((t) => {
        const on = t === tab;
        t.setAttribute("aria-selected", on ? "true" : "false");
        t.tabIndex = on ? 0 : -1;
        const p = document.getElementById(t.getAttribute("aria-controls"));
        p.hidden = !on;
        p.classList.toggle("is-on", on);
      });
      if (focus) tab.focus();
    };
    tabs.forEach((t, i) => {
      t.addEventListener("click", () => select(t));
      t.addEventListener("keydown", (e) => {
        let n = null;
        if (e.key === "ArrowRight") n = tabs[(i + 1) % tabs.length];
        else if (e.key === "ArrowLeft") n = tabs[(i - 1 + tabs.length) % tabs.length];
        else if (e.key === "Home") n = tabs[0];
        else if (e.key === "End") n = tabs[tabs.length - 1];
        if (n) { e.preventDefault(); select(n, true); }
      });
    });
    window.selectInstallTab = (id) => { const t = root.querySelector("#" + id); if (t) select(t); };
  });

  // ---- copy buttons ----
  document.querySelectorAll("[data-copy]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const code = btn.closest(".code-card").querySelector("pre").innerText;
      try { await navigator.clipboard.writeText(code); } catch {
        const ta = document.createElement("textarea");
        ta.value = code; document.body.appendChild(ta); ta.select();
        try { document.execCommand("copy"); } catch {}
        ta.remove();
      }
      btn.textContent = "Copied";
      btn.dataset.done = "1";
      setTimeout(() => { btn.textContent = "Copy"; delete btn.dataset.done; }, 1600);
    });
  });

  // ---- command palette ----
  const pal = document.getElementById("pal");
  const input = document.getElementById("pal-in");
  const list = document.getElementById("pal-list");
  const items = [
    { t: "Install", k: "Section", h: "#install" },
    { t: "Install for Claude Code", k: "Install", h: "#install", tab: "t-cc" },
    { t: "Install for Codex", k: "Install", h: "#install", tab: "t-cx" },
    { t: "Install for opencode", k: "Install", h: "#install", tab: "t-oc" },
    { t: "Install for Cursor", k: "Install", h: "#install", tab: "t-cu" },
    { t: "Install for Gemini CLI", k: "Install", h: "#install", tab: "t-ge" },
    { t: "Use as a library", k: "Install", h: "#install", tab: "t-lib" },
    { t: "How it works", k: "Section", h: "#how" },
    { t: "Command and store reference", k: "Section", h: "#reference" },
    { t: "Guides", k: "Section", h: "#guides" },
    { t: "Set it up through your agent", k: "Section", h: "#agents" },
    { t: "Resources", k: "Section", h: "#resources" },
    { t: "Straight answers", k: "Section", h: "#faq" },
    { t: "GitHub repository", k: "Link", h: "https://github.com/isiomaC/memstack" },
    { t: "MCP setup for every client", k: "Link", h: "https://github.com/isiomaC/memstack/blob/main/docs/MCP_SETUP.md" },
    { t: "npm: @memstack/cli", k: "Link", h: "https://www.npmjs.com/package/@memstack/cli" },
    { t: "MCP Registry", k: "Link", h: "https://registry.modelcontextprotocol.io/?q=io.github.isiomaC%2Fmemstack" },
    { t: "llms.txt", k: "Link", h: "llms.txt" },
  ];
  let shown = [];
  let sel = 0;
  let opener = null;

  const render = (q) => {
    const s = q.trim().toLowerCase();
    shown = items.filter((i) => !s || i.t.toLowerCase().includes(s) || i.k.toLowerCase().includes(s));
    sel = 0;
    list.innerHTML = "";
    if (!shown.length) {
      const li = document.createElement("li");
      li.className = "pal__empty"; li.textContent = "Nothing matches.";
      list.appendChild(li); return;
    }
    shown.forEach((i, idx) => {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = i.h; a.setAttribute("role", "option");
      a.setAttribute("aria-selected", idx === 0 ? "true" : "false");
      a.innerHTML = "<span></span><small></small>";
      a.firstChild.textContent = i.t; a.lastChild.textContent = i.k;
      a.addEventListener("click", () => go(i));
      li.appendChild(a); list.appendChild(li);
    });
  };
  const mark = () => [...list.querySelectorAll("a")].forEach((a, i) => a.setAttribute("aria-selected", i === sel ? "true" : "false"));
  const open = () => {
    opener = document.activeElement;
    pal.hidden = false; pal.classList.add("is-open");
    input.value = ""; render(""); input.focus();
  };
  const close = () => {
    pal.classList.remove("is-open"); pal.hidden = true;
    if (opener && opener.focus) opener.focus();
  };
  const go = (i) => {
    if (i.tab && window.selectInstallTab) window.selectInstallTab(i.tab);
    close();
    if (i.h.startsWith("#")) { const el = document.querySelector(i.h); if (el) el.scrollIntoView({ behavior: reduce ? "auto" : "smooth" }); history.replaceState(null, "", i.h); }
    else window.open(i.h, i.h.startsWith("http") ? "_blank" : "_self", "noopener");
  };

  document.querySelectorAll("[data-open-palette]").forEach((b) => b.addEventListener("click", open));
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); pal.hidden ? open() : close(); return; }
    if (pal.hidden) return;
    if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); sel = Math.min(sel + 1, shown.length - 1); mark(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); sel = Math.max(sel - 1, 0); mark(); }
    else if (e.key === "Enter" && shown[sel]) { e.preventDefault(); go(shown[sel]); }
    else if (e.key === "Tab") { e.preventDefault(); input.focus(); }
  });
  input.addEventListener("input", () => render(input.value));
  pal.addEventListener("mousedown", (e) => { if (e.target === pal) close(); });

  // modifier label for non-Mac
  if (!/Mac|iPhone|iPad/.test(navigator.platform)) document.querySelectorAll(".kbd-btn kbd").forEach((k) => (k.textContent = "Ctrl K"));
})();
