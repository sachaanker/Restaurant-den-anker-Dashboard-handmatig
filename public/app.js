(function () {
  "use strict";

  const fmtMoney = (n) =>
    new Intl.NumberFormat("nl-BE", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(n);
  const fmtPct = (n) => (n === null || n === undefined ? "—" : `${(n * 100).toFixed(1)}%`);
  const fmtInt = (n) => new Intl.NumberFormat("nl-BE").format(n);

  const METRIC_DEFS = [
    { key: "revenue", label: "Omzet", format: (m) => (m.revenue === null ? null : fmtMoney(m.revenue)) },
    {
      key: "transactions",
      label: "Aantal transacties",
      format: (m) => (m.transactions === null ? null : fmtInt(m.transactions)),
    },
    {
      key: "acs",
      label: "Gemiddelde besteding",
      format: (m) => (m.acs === null ? null : m.acs === "dash" ? "—" : fmtMoney(m.acs)),
    },
    {
      key: "cogs",
      label: "Kostprijs verkopen",
      format: (m) => (m.cogs === null ? null : `${fmtMoney(m.cogs)} · ${fmtPct(m.cogsPct)}`),
    },
    {
      key: "wagePct",
      label: "Loonpercentage",
      format: (m) => (m.wagePct === null ? null : fmtPct(m.wagePct)),
    },
    { key: "overheads", label: "Overheadkosten", format: (m) => (m.overheads === null ? null : fmtMoney(m.overheads)) },
    {
      key: "profit",
      label: "Winst",
      format: (m) => (m.profit === null ? null : `${fmtMoney(m.profit)} · ${fmtPct(m.profitPct)}`),
      isLoss: (m) => m.profit !== null && m.profit < 0,
    },
  ];

  const screens = {
    setup: document.getElementById("screen-setup"),
    login: document.getElementById("screen-login"),
    dashboard: document.getElementById("screen-dashboard"),
  };

  function showScreen(name) {
    Object.values(screens).forEach((s) => s.classList.add("hidden"));
    screens[name].classList.remove("hidden");
  }

  async function api(path, options = {}) {
    const res = await fetch(path, {
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      ...options,
    });
    if (res.status === 401) {
      showScreen("login");
      throw new Error("unauthenticated");
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `request_failed_${res.status}`);
    }
    return res.json();
  }

  // ---------- boot ----------
  async function boot() {
    const status = await api("/api/status");
    if (!status.passwordSet) {
      showScreen("setup");
      return;
    }
    if (!status.authed) {
      showScreen("login");
      return;
    }
    showScreen("dashboard");
    await initDashboard();
  }

  document.getElementById("setup-submit").addEventListener("click", async () => {
    const password = document.getElementById("setup-password").value;
    const errEl = document.getElementById("setup-error");
    errEl.classList.add("hidden");
    if (password.length < 8) {
      errEl.textContent = "Kies minstens 8 tekens.";
      errEl.classList.remove("hidden");
      return;
    }
    try {
      await api("/api/setup-password", { method: "POST", body: JSON.stringify({ password }) });
      showScreen("dashboard");
      await initDashboard();
    } catch (e) {
      errEl.textContent = "Er ging iets mis, probeer opnieuw.";
      errEl.classList.remove("hidden");
    }
  });

  document.getElementById("login-submit").addEventListener("click", async () => {
    const password = document.getElementById("login-password").value;
    const errEl = document.getElementById("login-error");
    errEl.classList.add("hidden");
    try {
      await api("/api/login", { method: "POST", body: JSON.stringify({ password }) });
      showScreen("dashboard");
      await initDashboard();
    } catch (e) {
      errEl.textContent = "Wachtwoord klopt niet.";
      errEl.classList.remove("hidden");
    }
  });

  document.getElementById("logout-btn").addEventListener("click", async () => {
    await api("/api/logout", { method: "POST" });
    showScreen("login");
  });

  // ---------- dashboard ----------
  let currentSettings = null;
  let currentPeriod = "this_week";

  async function initDashboard() {
    currentSettings = await api("/api/settings");
    document.getElementById("venue-name").textContent = currentSettings.venueName;
    currentPeriod = currentSettings.defaultPeriod || "this_week";
    setActivePeriodButton(currentPeriod);
    wireNav();
    wirePeriodButtons();
    wireEntryForm();
    wireSettingsForm();
    fillSettingsForm();
    await loadBoard();
    await loadEntryTable();
  }

  function wireNav() {
    document.querySelectorAll(".tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
        tab.classList.add("active");
        const view = tab.dataset.view;
        document.querySelectorAll(".view").forEach((v) => v.classList.add("hidden"));
        document.getElementById(`view-${view}`).classList.remove("hidden");
      });
    });
  }

  function setActivePeriodButton(key) {
    document.querySelectorAll("#period-buttons button").forEach((b) => {
      b.classList.toggle("active", b.dataset.period === key);
    });
  }

  function wirePeriodButtons() {
    document.querySelectorAll("#period-buttons button").forEach((btn) => {
      btn.addEventListener("click", async () => {
        currentPeriod = btn.dataset.period;
        setActivePeriodButton(currentPeriod);
        const customRange = document.getElementById("custom-range");
        if (currentPeriod === "custom") {
          customRange.classList.remove("hidden");
          return;
        }
        customRange.classList.add("hidden");
        await loadBoard();
      });
    });
    document.getElementById("custom-apply").addEventListener("click", loadBoard);
  }

  function sparklineSVG(trend) {
    const values = trend.map((t) => (typeof t.revenue === "number" ? t.revenue : null));
    const present = values.filter((v) => v !== null);
    if (present.length < 2) return "";
    const max = Math.max(...present);
    const min = Math.min(...present);
    const range = max - min || 1;
    const w = 200,
      h = 32;
    const step = w / (values.length - 1 || 1);
    let d = "";
    values.forEach((v, i) => {
      if (v === null) return;
      const x = i * step;
      const y = h - ((v - min) / range) * h;
      d += (d ? "L" : "M") + x.toFixed(1) + "," + y.toFixed(1);
    });
    return `<svg class="kpi-sparkline" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
      <path d="${d}" fill="none" stroke="var(--brass)" stroke-width="2" />
    </svg>`;
  }

  function deltaHTML(value) {
    if (value === null || value === undefined) return `<span class="delta flat">n.v.t.</span>`;
    const pct = fmtPct(Math.abs(value));
    if (value > 0.001) return `<span class="delta up">▲ ${pct}</span>`;
    if (value < -0.001) return `<span class="delta down">▼ ${pct}</span>`;
    return `<span class="delta flat">– ${pct}</span>`;
  }

  async function loadBoard() {
    const params = new URLSearchParams({ period: currentPeriod });
    if (currentPeriod === "custom") {
      const start = document.getElementById("custom-start").value;
      const end = document.getElementById("custom-end").value;
      if (!start || !end) return;
      params.set("start", start);
      params.set("end", end);
    }
    const data = await api(`/api/data?${params.toString()}`);
    document.getElementById("period-label").textContent = `${data.period.start} → ${data.period.end}`;

    const grid = document.getElementById("kpi-grid");
    grid.innerHTML = "";
    for (const def of METRIC_DEFS) {
      const formatted = def.format(data.metrics);
      const comp = data.comparison[def.key] || { vsPrevious: null, vsLastYear: null };
      const card = document.createElement("div");
      card.className = "kpi-card";
      const isLoss = def.isLoss ? def.isLoss(data.metrics) : false;
      card.innerHTML = `
        <div class="kpi-label">${def.label}</div>
        <div class="kpi-value ${formatted === null ? "not-configured" : isLoss ? "loss" : ""}">
          ${formatted === null ? "Niet ingesteld" : formatted}
        </div>
        <div class="kpi-deltas">
          ${deltaHTML(comp.vsPrevious)}
          ${deltaHTML(comp.vsLastYear)}
        </div>
        ${def.key === "revenue" ? sparklineSVG(data.trend) : ""}
        <div class="kpi-badge">Manueel ingegeven</div>
      `;
      grid.appendChild(card);
    }

    const lastSynced = document.getElementById("last-synced");
    lastSynced.textContent = data.lastSynced
      ? `Laatst bijgewerkt: ${new Date(data.lastSynced).toLocaleString("nl-BE")}`
      : "Nog geen gegevens binnengekomen.";

    const banner = document.getElementById("unverified-banner");
    banner.classList.toggle("hidden", !data.metrics.hasAnyData);
  }

  // ---------- entries ----------
  function wireEntryForm() {
    document.getElementById("entry-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const payload = {
        date: document.getElementById("entry-date").value,
        revenue: numOrUndefined("entry-revenue"),
        costOfSales: numOrUndefined("entry-cogs"),
        wages: numOrUndefined("entry-wages"),
        superAmount: numOrUndefined("entry-super"),
        overheads: numOrUndefined("entry-overheads"),
        transactions: numOrUndefined("entry-transactions"),
      };
      const status = document.getElementById("entry-status");
      try {
        await api("/api/entries", { method: "POST", body: JSON.stringify(payload) });
        status.textContent = "Opgeslagen.";
        status.classList.remove("hidden");
        await loadEntryTable();
        await loadBoard();
      } catch (err) {
        status.textContent = "Kon niet opslaan, probeer opnieuw.";
        status.classList.remove("hidden");
      }
    });
  }

  function numOrUndefined(id) {
    const v = document.getElementById(id).value;
    return v === "" ? undefined : Number(v);
  }

  async function loadEntryTable() {
    const end = new Date();
    const start = new Date(end.getTime() - 29 * 86400000);
    const iso = (d) => d.toISOString().slice(0, 10);
    const data = await api(`/api/entries?start=${iso(start)}&end=${iso(end)}`);
    const tbody = document.querySelector("#entry-table tbody");
    tbody.innerHTML = "";
    data.entries
      .slice()
      .reverse()
      .forEach((e) => {
        const tr = document.createElement("tr");
        const wageTotal = (e.wages || 0) + (e.superAmount || 0);
        tr.innerHTML = `
          <td>${e.date}</td>
          <td>${e.revenue !== undefined ? fmtMoney(e.revenue) : "—"}</td>
          <td>${e.costOfSales !== undefined ? fmtMoney(e.costOfSales) : "—"}</td>
          <td>${wageTotal ? fmtMoney(wageTotal) : "—"}</td>
          <td>${e.overheads !== undefined ? fmtMoney(e.overheads) : "—"}</td>
          <td>${e.transactions !== undefined ? fmtInt(e.transactions) : "—"}</td>
        `;
        tbody.appendChild(tr);
      });
  }

  // ---------- settings ----------
  function fillSettingsForm() {
    document.getElementById("set-venue-name").value = currentSettings.venueName || "";
    document.getElementById("set-week-start").value = String(currentSettings.weekStart ?? 1);
    document.getElementById("set-default-period").value = currentSettings.defaultPeriod || "this_week";
    document.getElementById("set-color").value = currentSettings.color || "#B8863E";
    document.getElementById("set-target-revenue").value = currentSettings.targets?.revenuePerWeek ?? "";
    document.getElementById("set-target-wage-pct").value = currentSettings.targets?.wagePct ?? "";
  }

  function wireSettingsForm() {
    document.getElementById("settings-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const payload = {
        venueName: document.getElementById("set-venue-name").value,
        weekStart: Number(document.getElementById("set-week-start").value),
        defaultPeriod: document.getElementById("set-default-period").value,
        color: document.getElementById("set-color").value,
        timezone: currentSettings.timezone || "Europe/Brussels",
        targets: {
          revenuePerWeek: numOrUndefined("set-target-revenue"),
          wagePct: numOrUndefined("set-target-wage-pct"),
        },
      };
      const status = document.getElementById("settings-status");
      try {
        await api("/api/settings", { method: "POST", body: JSON.stringify(payload) });
        currentSettings = payload;
        document.getElementById("venue-name").textContent = payload.venueName;
        status.textContent = "Bewaard.";
        status.classList.remove("hidden");
      } catch (err) {
        status.textContent = "Kon niet bewaren.";
        status.classList.remove("hidden");
      }
    });
  }

  boot();
})();
