import { useState, useMemo, useCallback } from "react";
import {
  ComposedChart, Area, XAxis, YAxis, Tooltip,
  ReferenceLine, ResponsiveContainer,
} from "recharts";

/* ─────────────────────────────────────────────────────────────
   FORMATTERS
───────────────────────────────────────────────────────────── */
const fmtINR = (n) => {
  if (!isFinite(n) || isNaN(n)) return "₹—";
  const abs = Math.abs(n);
  if (abs >= 1e7) return `₹${(n / 1e7).toFixed(2)} Cr`;
  if (abs >= 1e5) return `₹${(n / 1e5).toFixed(2)} L`;
  if (abs >= 1e3) return `₹${(n / 1e3).toFixed(1)}K`;
  return `₹${Math.round(n)}`;
};
const fmtINRFull = (n) => {
  if (!isFinite(n) || isNaN(n)) return "₹—";
  const neg = n < 0;
  const s = Math.round(Math.abs(n)).toString();
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3);
  const fmt = rest
    ? rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," + last3
    : last3;
  return `${neg ? "-" : ""}₹${fmt}`;
};

/* ─────────────────────────────────────────────────────────────
   TAX ENGINE  (FY 2025-26)
───────────────────────────────────────────────────────────── */
function calcTax(gross, regime, c80C = 150000, c80D = 25000, nps80CCD = 50000) {
  let taxable, tax;
  if (regime === "new") {
    taxable = Math.max(0, gross - 75000);
    const slabs = [
      [400000, 0], [400000, 0.05], [400000, 0.10],
      [400000, 0.15], [400000, 0.20], [400000, 0.25], [Infinity, 0.30],
    ];
    tax = 0;
    let rem = taxable;
    for (const [lim, r] of slabs) {
      if (rem <= 0) break;
      tax += Math.min(rem, lim) * r;
      rem -= lim;
    }
    if (taxable <= 1200000) tax = 0; // 87A rebate
  } else {
    const deductions =
      Math.min(c80C, 150000) + Math.min(c80D, 25000) + Math.min(nps80CCD, 50000);
    taxable = Math.max(0, gross - 50000 - deductions);
    if (taxable <= 250000) tax = 0;
    else if (taxable <= 500000) tax = (taxable - 250000) * 0.05;
    else if (taxable <= 1000000) tax = 12500 + (taxable - 500000) * 0.20;
    else tax = 112500 + (taxable - 1000000) * 0.30;
    if (taxable <= 500000) tax = 0; // 87A rebate
  }
  let surcharge = 0;
  if (taxable > 5000000 && taxable <= 10000000) surcharge = tax * 0.10;
  else if (taxable > 10000000 && taxable <= 20000000) surcharge = tax * 0.15;
  else if (taxable > 20000000) surcharge = tax * (regime === "new" ? 0.25 : 0.37);
  const total = (tax + surcharge) * 1.04; // 4% cess
  return { total: Math.round(total), taxable };
}

function marginalRate(taxable, regime) {
  if (regime === "new") {
    if (taxable <= 400000) return 0;
    if (taxable <= 800000) return 0.052;
    if (taxable <= 1200000) return 0.104;
    if (taxable <= 1600000) return 0.156;
    if (taxable <= 2000000) return 0.208;
    if (taxable <= 2400000) return 0.26;
    return 0.312;
  } else {
    if (taxable <= 250000) return 0;
    if (taxable <= 500000) return 0.052;
    if (taxable <= 1000000) return 0.208;
    return 0.312;
  }
}

/* ─────────────────────────────────────────────────────────────
   PROJECTION ENGINE
   Handles: income growth, post-tax savings, EPF/PPF/NPS,
   EMI payoff, healthcare inflation, LTCG/debt tax each year.
───────────────────────────────────────────────────────────── */
function project(p, eqOvr = null, dtOvr = null) {
  const {
    annualCTC, incomeGrowthRate, regime, ded80C, ded80D, npsContrib,
    annualExpenses, emiMonthly, emiYears, healthcarePremium,
    currentPortfolio, currentEPF, currentPPF, currentNPS,
    epfMonthly, ppfAnnual,
    equityAlloc, equityReturn, debtReturn, epfRate, ppfRate,
    currentAge, fireNumber,
  } = p;

  let portfolio = currentPortfolio;
  let epf = currentEPF;
  let ppf = currentPPF;
  let nps = currentNPS;
  const eqFrac = equityAlloc / 100;
  const debtFrac = 1 - eqFrac;
  let yearsToFire = null;

  const data = [{
    year: 0, age: currentAge,
    portfolio: Math.round(portfolio), epf: Math.round(epf),
    ppf: Math.round(ppf), nps: Math.round(nps),
    total: Math.round(portfolio + epf + ppf + nps),
  }];

  for (let y = 1; y <= 65; y++) {
    // Income grows with career
    const ctcY = annualCTC * Math.pow(1 + incomeGrowthRate / 100, y - 1);
    const { total: taxY, taxable: tiY } = calcTax(ctcY, regime, ded80C, ded80D, npsContrib);
    const postTaxY = ctcY - taxY;
    const mRate = marginalRate(tiY, regime);

    // Contributions (EPF scales with income)
    const epfContribY = Math.min(epfMonthly * Math.pow(1 + incomeGrowthRate / 100, y - 1) * 12, 180000);
    const ppfContribY = Math.min(ppfAnnual, 150000);
    const emiAmt = y <= emiYears ? emiMonthly * 12 : 0;
    const healthAmt = healthcarePremium * Math.pow(1.10, y - 1); // 10% healthcare inflation

    const savingsY = Math.max(
      0,
      postTaxY - annualExpenses - epfContribY - ppfContribY - npsContrib - emiAmt - healthAmt
    );

    // Investment returns (with optional Monte Carlo overrides)
    const eqRet = eqOvr ? eqOvr[y - 1] : equityReturn / 100;
    const dtRet = dtOvr ? dtOvr[y - 1] : debtReturn / 100;

    const equityGain = portfolio * eqFrac * eqRet;
    const debtGain = portfolio * debtFrac * dtRet;
    // LTCG: 12.5% above ₹1.25L/yr; debt taxed at slab
    const ltcgTax = 0.125 * Math.max(0, equityGain - 125000);
    const debtTax = debtGain * mRate;

    portfolio += equityGain + debtGain - ltcgTax - debtTax + savingsY;
    portfolio = Math.max(0, portfolio);

    // EPF: employee + employer both contribute; grows at EPF rate
    epf = (epf + epfContribY * 2) * (1 + epfRate / 100);
    // PPF: EEE, grows at PPF rate
    ppf = (ppf + ppfContribY) * (1 + ppfRate / 100);
    // NPS: ~10% return (mixed fund); grows with contribution
    nps = (nps + npsContrib) * 1.10;

    const total = portfolio + epf + ppf + nps;
    if (!yearsToFire && total >= fireNumber) yearsToFire = y;

    data.push({
      year: y, age: currentAge + y,
      portfolio: Math.round(portfolio), epf: Math.round(epf),
      ppf: Math.round(ppf), nps: Math.round(nps),
      total: Math.round(total),
    });

    // Run 10 extra years past FIRE for post-retirement view
    if (y > (yearsToFire ?? 65) + 10) break;
  }

  return { data, yearsToFire: yearsToFire ?? 65 };
}

/* ─────────────────────────────────────────────────────────────
   MONTE CARLO  (Box-Muller normal distribution)
───────────────────────────────────────────────────────────── */
function randn() {
  let u = 0, v = 0;
  while (!u) u = Math.random();
  while (!v) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function runMC(params, runs = 250) {
  const results = [];
  for (let r = 0; r < runs; r++) {
    const eqOvr = Array.from({ length: 65 }, () =>
      Math.max(-0.45, params.equityReturn / 100 + randn() * 0.17)
    );
    const dtOvr = Array.from({ length: 65 }, () =>
      Math.max(-0.02, params.debtReturn / 100 + randn() * 0.03)
    );
    const { data, yearsToFire } = project(params, eqOvr, dtOvr);
    results.push({ data, yearsToFire });
  }
  return results;
}

/* ─────────────────────────────────────────────────────────────
   UI ATOMS
───────────────────────────────────────────────────────────── */
const Card = ({ children, style }) => (
  <div style={{
    background: "#0d1829", border: "1px solid #1e2d47",
    borderRadius: "10px", padding: "16px 18px", ...style,
  }}>{children}</div>
);

const SectionLabel = ({ children, color = "#475569" }) => (
  <div style={{
    fontSize: "9px", letterSpacing: "0.14em", textTransform: "uppercase",
    color, marginBottom: "8px", fontWeight: 700,
  }}>{children}</div>
);

const TRow = ({ label, value, color = "#64748b", bold, sub }) => (
  <div style={{
    display: "flex", justifyContent: "space-between", alignItems: "flex-start",
    padding: "5px 0", borderBottom: "1px solid #1a2740",
  }}>
    <div>
      <div style={{ fontSize: "11px", color: "#64748b" }}>{label}</div>
      {sub && <div style={{ fontSize: "9px", color: "#334155" }}>{sub}</div>}
    </div>
    <span style={{
      fontFamily: "'JetBrains Mono', monospace", fontSize: "11px",
      color, fontWeight: bold ? 700 : 400, marginLeft: "8px", textAlign: "right",
    }}>{value}</span>
  </div>
);

const Slider = ({ label, field, min, max, step = 1, prefix = "", suffix = "", inputs, set, hint }) => {
  const val = inputs[field];
  const isRaw = field.includes("Rate") || field.includes("Alloc") || field.includes("Growth") ||
    field === "withdrawalRate" || field === "inflationRate" || field === "emiYears" || field === "currentAge";
  const display = isRaw ? val : Number(val).toLocaleString("en-IN");
  return (
    <div style={{ marginBottom: "15px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "4px" }}>
        <span style={{ fontSize: "9.5px", letterSpacing: "0.1em", color: "#4b6080", textTransform: "uppercase" }}>{label}</span>
        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "12px", color: "#fb923c", fontWeight: 500 }}>
          {prefix}{display}{suffix}
        </span>
      </div>
      <input type="range" min={min} max={max} step={step} value={val}
        onChange={(e) => set(field)(e)} style={{ width: "100%", accentColor: "#fb923c" }} />
      {hint && <div style={{ fontSize: "9px", color: "#2a3f5a", marginTop: "2px" }}>{hint}</div>}
    </div>
  );
};

/* ─────────────────────────────────────────────────────────────
   DEFAULT INPUTS
───────────────────────────────────────────────────────────── */
const DEFAULTS = {
  currentAge: 28,
  annualCTC: 1500000,
  incomeGrowthRate: 8,
  ded80C: 150000,
  ded80D: 25000,
  npsContrib: 50000,
  annualExpenses: 600000,
  postFireExpenses: 600000,
  otherIncomeAtFire: 0,
  emiMonthly: 0,
  emiYears: 0,
  healthcarePremium: 30000,
  currentPortfolio: 500000,
  currentEPF: 200000,
  currentPPF: 0,
  currentNPS: 0,
  epfMonthly: 3600,
  ppfAnnual: 0,
  equityAlloc: 70,
  equityReturn: 12,
  debtReturn: 7,
  epfRate: 8.25,
  ppfRate: 7.1,
  withdrawalRate: 3.5,
  inflationRate: 6,
};

function loadInputs() {
  try {
    const h = window.location.hash.slice(1);
    if (h) return { ...DEFAULTS, ...JSON.parse(atob(h)) };
  } catch { }
  return DEFAULTS;
}

/* ─────────────────────────────────────────────────────────────
   MAIN COMPONENT
───────────────────────────────────────────────────────────── */
export default function FireIndia() {
  const [tab, setTab] = useState(0);
  const [regime, setRegime] = useState("new");
  const [showMC, setShowMC] = useState(false);
  const [copied, setCopied] = useState(false);
  const [inputs, setInputs] = useState(loadInputs);

  const set = useCallback(
    (key) => (e) => setInputs((p) => ({ ...p, [key]: parseFloat(e.target.value) || 0 })),
    []
  );

  const share = () => {
    window.location.hash = btoa(JSON.stringify(inputs));
    navigator.clipboard?.writeText(window.location.href).catch(() => { });
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  };

  /* ── Core calculation ── */
  const calc = useMemo(() => {
    const {
      annualCTC, incomeGrowthRate, ded80C, ded80D, npsContrib,
      annualExpenses, postFireExpenses, otherIncomeAtFire,
      emiMonthly, emiYears, healthcarePremium,
      currentPortfolio, currentEPF, currentPPF, currentNPS,
      epfMonthly, ppfAnnual,
      equityAlloc, equityReturn, debtReturn, epfRate, ppfRate,
      withdrawalRate, inflationRate, currentAge,
    } = inputs;

    const eqFrac = equityAlloc / 100;

    // Year-0 tax
    const { total: incomeTax0, taxable: ti0 } = calcTax(annualCTC, regime, ded80C, ded80D, npsContrib);
    const postTaxIncome0 = annualCTC - incomeTax0;
    const mRate0 = marginalRate(ti0, regime);

    // Regime comparison
    const { total: newTaxAmt } = calcTax(annualCTC, "new", ded80C, ded80D, npsContrib);
    const { total: oldTaxAmt } = calcTax(annualCTC, "old", ded80C, ded80D, npsContrib);

    // FIRE number: based on post-FIRE expenses net of other income
    const netMonthlyNeed = Math.max(0, postFireExpenses / 12 - otherIncomeAtFire);
    const netAnnualNeed = netMonthlyNeed * 12;
    const ltcgOnWithdrawal = 0.125 * Math.max(0, netAnnualNeed * eqFrac * 0.75 - 125000);
    const fireNumber = (netAnnualNeed + ltcgOnWithdrawal) / (withdrawalRate / 100);

    // Lean / Fat FIRE numbers
    const leanFireNum = (postFireExpenses * 0.50) / (withdrawalRate / 100);
    const fatFireNum = (postFireExpenses * 2.00) / (withdrawalRate / 100);

    // Real blended return (post-tax estimate for coast FIRE)
    const realBlended =
      eqFrac * (equityReturn - inflationRate) / 100 * 0.895 +
      (1 - eqFrac) * (debtReturn - inflationRate) / 100 * (1 - mRate0);

    // Base projection params (shared with MC)
    const projParams = {
      annualCTC, incomeGrowthRate, regime, ded80C, ded80D, npsContrib,
      annualExpenses, emiMonthly, emiYears, healthcarePremium,
      currentPortfolio, currentEPF, currentPPF, currentNPS,
      epfMonthly, ppfAnnual,
      equityAlloc, equityReturn, debtReturn, epfRate, ppfRate,
      currentAge, fireNumber,
    };

    const { data: chartData, yearsToFire } = project(projParams);
    const retireAge = currentAge + yearsToFire;

    // Lean / Fat projections
    const { yearsToFire: leanYears } = project({ ...projParams, fireNumber: leanFireNum });
    const { yearsToFire: fatYears } = project({ ...projParams, fireNumber: fatFireNum });

    // Coast FIRE = how much you need today so compound alone reaches FIRE
    const coastFire = yearsToFire > 0 && realBlended > 0
      ? fireNumber / Math.pow(1 + realBlended, yearsToFire)
      : fireNumber;

    const totalCorpusNow = currentPortfolio + currentEPF + currentPPF + currentNPS;
    const progress = Math.min((totalCorpusNow / fireNumber) * 100, 100);
    const coastReached = totalCorpusNow >= coastFire;
    const coastProgress = Math.min((totalCorpusNow / Math.max(coastFire, 1)) * 100, 100);

    // Investable surplus (year 0)
    const epfAnnual0 = epfMonthly * 12;
    const emi0 = emiYears > 0 ? emiMonthly * 12 : 0;
    const netSavings0 = Math.max(0, postTaxIncome0 - annualExpenses - epfAnnual0 - ppfAnnual - npsContrib - emi0 - healthcarePremium);
    const savingsRate0 = postTaxIncome0 > 0 ? (netSavings0 / postTaxIncome0) * 100 : 0;

    const idxAtFire = Math.min(yearsToFire, chartData.length - 1);
    const epfAtFire = chartData[idxAtFire]?.epf ?? 0;
    const ppfAtFire = chartData[idxAtFire]?.ppf ?? 0;
    const npsAtFire = chartData[idxAtFire]?.nps ?? 0;
    const totalAtFire = chartData[idxAtFire]?.total ?? 0;

    return {
      incomeTax0, postTaxIncome0, ti0, mRate0,
      newTaxAmt, oldTaxAmt,
      fireNumber, leanFireNum, fatFireNum, coastFire, coastReached,
      netAnnualNeed, ltcgOnWithdrawal,
      chartData, yearsToFire, retireAge, leanYears, fatYears,
      totalCorpusNow, progress, coastProgress,
      epfAtFire, ppfAtFire, npsAtFire, totalAtFire,
      netSavings0, savingsRate0, realBlended,
      projParams,
    };
  }, [inputs, regime]);

  /* ── Monte Carlo ── */
  const mcData = useMemo(() => {
    if (!showMC) return null;
    const results = runMC(calc.projParams, 250);
    const maxLen = Math.max(...results.map((r) => r.data.length));
    const bands = [];
    for (let i = 0; i < maxLen; i++) {
      const vals = results
        .map((r) => r.data[i]?.total ?? 0)
        .sort((a, b) => a - b);
      bands.push({
        p10: vals[Math.floor(vals.length * 0.10)] ?? 0,
        p50: vals[Math.floor(vals.length * 0.50)] ?? 0,
        p90: vals[Math.floor(vals.length * 0.90)] ?? 0,
      });
    }
    const successCount = results.filter((r) => r.yearsToFire <= calc.yearsToFire + 2).length;
    return {
      bands,
      successRate: Math.round(successCount / results.length * 100),
      medianAtFire: bands[Math.min(calc.yearsToFire, bands.length - 1)]?.p50 ?? 0,
      worstAtFire: bands[Math.min(calc.yearsToFire, bands.length - 1)]?.p10 ?? 0,
    };
  }, [showMC, calc.projParams, calc.yearsToFire]);

  /* ── Merge MC bands into chart data ── */
  const chartData = useMemo(() => {
    if (!mcData) return calc.chartData;
    return calc.chartData.map((d, i) => {
      const b = mcData.bands[i];
      return b
        ? { ...d, mcBase: b.p10, mcBand: Math.max(0, b.p90 - b.p10), mcP50: b.p50 }
        : d;
    });
  }, [calc.chartData, mcData]);

  /* ── Colors ── */
  const C = { saffron: "#fb923c", green: "#34d399", red: "#f87171", blue: "#60a5fa", purple: "#a78bfa", teal: "#2dd4bf" };

  /* ── FIRE variants data ── */
  const variants = [
    { key: "lean", label: "Lean FIRE", num: calc.leanFireNum, yrs: calc.leanYears, desc: "50% of expenses", color: C.blue },
    { key: "regular", label: "Regular FIRE", num: calc.fireNumber, yrs: calc.yearsToFire, desc: `${inputs.withdrawalRate}% SWR`, color: C.saffron },
    { key: "fat", label: "Fat FIRE", num: calc.fatFireNum, yrs: calc.fatYears, desc: "2× expenses", color: C.purple },
    { key: "coast", label: "Coast FIRE", num: calc.coastFire, yrs: null, desc: "Stop investing now", color: C.green },
  ];

  const TABS = ["Profile", "Expenses", "Assets", "Assumptions"];

  /* ── Custom chart tooltip ── */
  const Tip = ({ active, payload }) => {
    if (!active || !payload?.length) return null;
    const d = payload[0]?.payload;
    return (
      <div style={{ background: "#060f1e", border: "1px solid #1e2d47", padding: "10px 14px", borderRadius: "6px", minWidth: "170px" }}>
        <div style={{ color: "#4b6080", fontSize: "10px", marginBottom: "5px" }}>Age {d?.age} · Year {d?.year}</div>
        {[
          { key: "portfolio", label: "Investments", color: C.saffron },
          { key: "epf", label: "EPF", color: C.blue },
          { key: "ppf", label: "PPF", color: C.green },
          { key: "nps", label: "NPS", color: C.purple },
        ].map(({ key, label, color }) =>
          d?.[key] > 0 ? (
            <div key={key} style={{ display: "flex", justifyContent: "space-between", gap: "12px" }}>
              <span style={{ fontSize: "10px", color: "#4b6080" }}>{label}</span>
              <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "10px", color }}>{fmtINR(d[key])}</span>
            </div>
          ) : null
        )}
        <div style={{ borderTop: "1px solid #1e2d47", marginTop: "5px", paddingTop: "5px", display: "flex", justifyContent: "space-between" }}>
          <span style={{ fontSize: "10px", color: "#94a3b8" }}>Total</span>
          <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "11px", color: "#f1f5f9", fontWeight: 700 }}>{fmtINR(d?.total)}</span>
        </div>
        {showMC && d?.mcBase != null && (
          <div style={{ fontSize: "9px", color: "#334155", marginTop: "3px" }}>
            p10–p90: {fmtINR(d.mcBase)} – {fmtINR(d.mcBase + d.mcBand)}
          </div>
        )}
      </div>
    );
  };

  return (
    <div style={{ minHeight: "100vh", background: "#060d18", color: "#94a3b8", fontFamily: "'DM Sans', system-ui, sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=Playfair+Display:ital,wght@0,700;1,400&family=JetBrains+Mono:wght@400;500&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        input[type=range] { -webkit-appearance: none; height: 2px; background: #1a2740; border-radius: 2px; outline: none; width: 100%; cursor: pointer; }
        input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: 13px; height: 13px; border-radius: 50%; background: #fb923c; border: 2px solid #060d18; box-shadow: 0 0 8px rgba(251,146,60,0.45); }
        .tbtn { background: none; border: none; cursor: pointer; font-family: 'DM Sans',sans-serif; font-size: 10px; letter-spacing: 0.09em; text-transform: uppercase; padding: 7px 11px; transition: all 0.15s; border-bottom: 2px solid transparent; }
        .rbtn { background: none; border: 1px solid #1e2d47; cursor: pointer; font-family: 'DM Sans',sans-serif; font-size: 10px; padding: 4px 12px; border-radius: 4px; transition: all 0.15s; color: #4b6080; }
        .rbtn.on { background: #fb923c; border-color: #fb923c; color: #060d18; font-weight: 700; }
        .ibtn { background: none; border: 1px solid #1e2d47; cursor: pointer; font-family: 'DM Sans',sans-serif; font-size: 10px; padding: 4px 12px; border-radius: 4px; color: #4b6080; transition: all 0.15s; }
        .ibtn:hover { border-color: #fb923c; color: #fb923c; }
        .ibtn.on { border-color: #fb923c; color: #fb923c; background: rgba(251,146,60,0.08); }
        ::-webkit-scrollbar { width: 3px; } ::-webkit-scrollbar-thumb { background: #1e2d47; border-radius: 2px; }
        @keyframes fi { from { opacity:0; transform:translateY(5px); } to { opacity:1; transform:translateY(0); } }
        .fi { animation: fi 0.25s ease; }
      `}</style>

      {/* ── Header ── */}
      <div style={{
        padding: "14px 24px", borderBottom: "1px solid #0d1829",
        display: "flex", alignItems: "center", justifyContent: "space-between",
        background: "linear-gradient(180deg, #091020 0%, #060d18 100%)",
      }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: "12px" }}>
          <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: "22px", fontWeight: 700, color: "#f1f5f9" }}>
            🔥 FIRE <span style={{ fontStyle: "italic", color: C.saffron, fontWeight: 400 }}>India</span>
          </h1>
          <span style={{ fontSize: "9px", color: "#1e2d47", letterSpacing: "0.15em", textTransform: "uppercase" }}>
            Financial Independence · Retire Early
          </span>
        </div>
        <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
          <button className={`ibtn ${showMC ? "on" : ""}`} onClick={() => setShowMC((s) => !s)}>
            📊 {showMC ? "MC: On" : "Monte Carlo"}
          </button>
          <button className="ibtn" onClick={share}>{copied ? "✓ Copied!" : "🔗 Share"}</button>
          <div style={{ width: "1px", height: "16px", background: "#1e2d47", margin: "0 4px" }} />
          <span style={{ fontSize: "9.5px", color: "#334155" }}>Regime</span>
          <button className={`rbtn ${regime === "new" ? "on" : ""}`} onClick={() => setRegime("new")}>New</button>
          <button className={`rbtn ${regime === "old" ? "on" : ""}`} onClick={() => setRegime("old")}>Old</button>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "290px 1fr", minHeight: "calc(100vh - 53px)" }}>

        {/* ════════════════════ LEFT PANEL ════════════════════ */}
        <div style={{ borderRight: "1px solid #0d1829", display: "flex", flexDirection: "column" }}>

          {/* Tabs */}
          <div style={{ display: "flex", borderBottom: "1px solid #0d1829", padding: "0 8px" }}>
            {TABS.map((t, i) => (
              <button key={i} className="tbtn" onClick={() => setTab(i)} style={{
                color: tab === i ? C.saffron : "#334155",
                borderBottomColor: tab === i ? C.saffron : "transparent",
              }}>{t}</button>
            ))}
          </div>

          <div style={{ padding: "16px 14px", overflowY: "auto", flex: 1 }} className="fi" key={tab}>

            {/* ── Tab 0: Profile ── */}
            {tab === 0 && <>
              <Slider label="Current Age" field="currentAge" min={18} max={60} inputs={inputs} set={set} />
              <Slider label="Annual CTC / Gross Income" field="annualCTC" min={300000} max={15000000} step={50000} prefix="₹" inputs={inputs} set={set} />
              <Slider label="Income Growth Rate" field="incomeGrowthRate" min={0} max={20} step={0.5} suffix="%" inputs={inputs} set={set} hint="Annual salary hike — applied to CTC before tax each year" />

              {regime === "old" && (
                <div style={{ background: "rgba(251,146,60,0.05)", border: "1px solid rgba(251,146,60,0.12)", borderRadius: "8px", padding: "12px", margin: "10px 0" }}>
                  <SectionLabel color={C.saffron}>Old Regime Deductions</SectionLabel>
                  <Slider label="Section 80C" field="ded80C" min={0} max={150000} step={5000} prefix="₹" inputs={inputs} set={set} hint="ELSS, LIC, PPF, EPF, home loan principal" />
                  <Slider label="Section 80D (health)" field="ded80D" min={0} max={75000} step={5000} prefix="₹" inputs={inputs} set={set} />
                  <Slider label="NPS 80CCD(1B)" field="npsContrib" min={0} max={50000} step={5000} prefix="₹" inputs={inputs} set={set} hint="Extra ₹50K deduction over 80C limit" />
                </div>
              )}

              {/* Regime comparison */}
              <Card style={{ marginTop: "12px" }}>
                <SectionLabel>New vs Old Regime</SectionLabel>
                <TRow label="New Regime Tax" value={fmtINRFull(calc.newTaxAmt)}
                  color={calc.newTaxAmt <= calc.oldTaxAmt ? C.green : C.red} />
                <TRow label="Old Regime Tax" value={fmtINRFull(calc.oldTaxAmt)}
                  color={calc.oldTaxAmt < calc.newTaxAmt ? C.green : C.red} />
                <TRow label="Better Regime"
                  value={calc.newTaxAmt <= calc.oldTaxAmt ? "New ✓" : "Old ✓"} color={C.green} bold />
                <TRow label="You save" value={fmtINRFull(Math.abs(calc.newTaxAmt - calc.oldTaxAmt))} color={C.saffron} />
                <TRow label="Taxable Income" value={fmtINRFull(calc.ti0)} />
                <TRow label="Effective Rate"
                  value={`${inputs.annualCTC > 0 ? (calc.incomeTax0 / inputs.annualCTC * 100).toFixed(1) : 0}%`}
                  color={C.red} />
                <TRow label="Monthly Take-home" value={fmtINRFull(calc.postTaxIncome0 / 12)} color={C.green} bold />
              </Card>
            </>}

            {/* ── Tab 1: Expenses ── */}
            {tab === 1 && <>
              <Slider label="Current Annual Expenses" field="annualExpenses" min={100000} max={6000000} step={25000} prefix="₹" inputs={inputs} set={set} hint="During accumulation — commute, school fees, etc." />
              <Slider label="Post-FIRE Annual Expenses" field="postFireExpenses" min={100000} max={6000000} step={25000} prefix="₹" inputs={inputs} set={set} hint="After retirement — EMI, commute costs may drop" />
              <Slider label="Other Income at FIRE / mo" field="otherIncomeAtFire" min={0} max={300000} step={2000} prefix="₹" inputs={inputs} set={set} hint="Rent, dividends, spouse income, consulting" />

              <div style={{ borderTop: "1px solid #1a2740", margin: "12px 0", paddingTop: "12px" }}>
                <SectionLabel color={C.blue}>EMI / Loans</SectionLabel>
                <Slider label="EMI Amount / Month" field="emiMonthly" min={0} max={300000} step={2000} prefix="₹" inputs={inputs} set={set} />
                <Slider label="EMI Remaining (Years)" field="emiYears" min={0} max={30} inputs={inputs} set={set} hint="Surplus jumps once EMI ends — reflected in chart" />
              </div>

              <div style={{ borderTop: "1px solid #1a2740", margin: "12px 0", paddingTop: "12px" }}>
                <SectionLabel color={C.red}>Healthcare</SectionLabel>
                <Slider label="Health Premium / Year" field="healthcarePremium" min={0} max={500000} step={5000} prefix="₹" inputs={inputs} set={set} hint="Premium assumed to rise 10% p.a. (India avg)" />
              </div>

              <Card style={{ marginTop: "12px" }}>
                <SectionLabel>FIRE Number Breakdown</SectionLabel>
                <TRow label="Post-FIRE expenses / mo" value={fmtINRFull(inputs.postFireExpenses / 12)} color="#e2e8f0" />
                <TRow label="Other income / mo" value={`− ${fmtINRFull(inputs.otherIncomeAtFire)}`} color={C.green} />
                <TRow label="Net monthly need" value={fmtINRFull(calc.netAnnualNeed / 12)} color={C.saffron} bold />
                <TRow label="LTCG tax on withdrawals / yr" value={`+ ${fmtINRFull(calc.ltcgOnWithdrawal)}`} color={C.red} sub="12.5% on equity gains above ₹1.25L" />
                <TRow label="Total annual withdrawal" value={fmtINRFull(calc.netAnnualNeed + calc.ltcgOnWithdrawal)} color="#e2e8f0" />
                <TRow label="÷ SWR" value={`${inputs.withdrawalRate}%`} />
                <TRow label="FIRE Number" value={fmtINR(calc.fireNumber)} color={C.saffron} bold />
              </Card>
            </>}

            {/* ── Tab 2: Assets ── */}
            {tab === 2 && <>
              <SectionLabel>Investment Portfolio</SectionLabel>
              <Slider label="Current Portfolio" field="currentPortfolio" min={0} max={100000000} step={50000} prefix="₹" inputs={inputs} set={set} />

              <div style={{ borderTop: "1px solid #1a2740", margin: "12px 0", paddingTop: "12px" }}>
                <SectionLabel color={C.blue}>EPF (Employees' Provident Fund)</SectionLabel>
                <Slider label="Current EPF Balance" field="currentEPF" min={0} max={20000000} step={10000} prefix="₹" inputs={inputs} set={set} />
                <Slider label="Employee EPF / Month" field="epfMonthly" min={0} max={75000} step={500} prefix="₹" inputs={inputs} set={set} hint="Employer matches; scales with income growth. EEE." />
              </div>

              <div style={{ borderTop: "1px solid #1a2740", margin: "12px 0", paddingTop: "12px" }}>
                <SectionLabel color={C.green}>PPF (Public Provident Fund)</SectionLabel>
                <Slider label="Current PPF Balance" field="currentPPF" min={0} max={10000000} step={10000} prefix="₹" inputs={inputs} set={set} />
                <Slider label="PPF Annual Contribution" field="ppfAnnual" min={0} max={150000} step={5000} prefix="₹" inputs={inputs} set={set} hint="Max ₹1.5L/yr. 15-yr lock-in. Fully EEE tax-free." />
              </div>

              <div style={{ borderTop: "1px solid #1a2740", margin: "12px 0", paddingTop: "12px" }}>
                <SectionLabel color={C.purple}>NPS (National Pension System)</SectionLabel>
                <Slider label="Current NPS Corpus" field="currentNPS" min={0} max={20000000} step={10000} prefix="₹" inputs={inputs} set={set} />
                <Slider label="Annual NPS Contribution" field="npsContrib" min={0} max={500000} step={5000} prefix="₹" inputs={inputs} set={set} hint="Old regime: ₹50K extra deduction (80CCD1B). NPS ~10% return modelled." />
              </div>

              <Card style={{ marginTop: "12px" }}>
                <SectionLabel>Corpus at FIRE (estimated)</SectionLabel>
                <TRow label="Investments" value={fmtINR(calc.totalAtFire - calc.epfAtFire - calc.ppfAtFire - calc.npsAtFire)} color={C.saffron} />
                <TRow label="EPF" value={fmtINR(calc.epfAtFire)} color={C.blue} sub="Tax-free (EEE)" />
                <TRow label="PPF" value={fmtINR(calc.ppfAtFire)} color={C.green} sub="Tax-free (EEE)" />
                <TRow label="NPS" value={fmtINR(calc.npsAtFire)} color={C.purple} sub="60% tax-free · 40% annuity" />
                <TRow label="Total" value={fmtINR(calc.totalAtFire)} color={C.saffron} bold />
              </Card>
            </>}

            {/* ── Tab 3: Assumptions ── */}
            {tab === 3 && <>
              <Slider label="Equity Allocation" field="equityAlloc" min={0} max={100} suffix="%" inputs={inputs} set={set} />
              <Slider label="Equity Return (Nifty 50)" field="equityReturn" min={6} max={18} step={0.5} suffix="%" inputs={inputs} set={set} />
              <Slider label="Debt / FD Return" field="debtReturn" min={4} max={12} step={0.5} suffix="%" inputs={inputs} set={set} />
              <Slider label="EPF Interest Rate" field="epfRate" min={7} max={10} step={0.05} suffix="%" inputs={inputs} set={set} />
              <Slider label="PPF Interest Rate" field="ppfRate" min={6} max={9} step={0.1} suffix="%" inputs={inputs} set={set} />
              <Slider label="Safe Withdrawal Rate" field="withdrawalRate" min={2} max={5} step={0.1} suffix="%" inputs={inputs} set={set} hint="3–4% recommended for 30+ yr retirement" />
              <Slider label="Inflation Rate" field="inflationRate" min={3} max={10} step={0.5} suffix="%" inputs={inputs} set={set} />

              <Card style={{ marginTop: "14px" }}>
                <SectionLabel>Investment Tax (FY 2025-26)</SectionLabel>
                <TRow label="Equity LTCG (>1 yr)" value="12.5% above ₹1.25L" color={C.saffron} />
                <TRow label="LTCG harvest per year" value="Up to ₹1.25L tax-free" color={C.green} sub="Book every March — free alpha" />
                <TRow label="Equity STCG (<1 yr)" value="20%" color={C.red} />
                <TRow label="Debt MF (all periods)" value={`${(calc.mRate0 * 100).toFixed(1)}% slab`} />
                <TRow label="EPF / PPF" value="EEE — fully tax-free ✓" color={C.green} />
                <TRow label="NPS at withdrawal" value="60% tax-free + 40% annuity" color={C.purple} />
              </Card>
            </>}
          </div>
        </div>

        {/* ════════════════════ RIGHT PANEL ════════════════════ */}
        <div style={{ padding: "18px 22px", overflowY: "auto" }}>

          {/* FIRE Variants */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "10px", marginBottom: "14px" }}>
            {variants.map((v) => (
              <Card key={v.key} style={{ padding: "14px 16px", borderColor: `${v.color}22` }}>
                <div style={{ display: "flex", align: "center", gap: "5px", marginBottom: "6px" }}>
                  <div style={{ width: "5px", height: "5px", borderRadius: "50%", background: v.color, marginTop: "1px" }} />
                  <SectionLabel color={v.color}>{v.label}</SectionLabel>
                </div>
                <div style={{
                  fontFamily: "'JetBrains Mono', monospace", fontSize: "19px",
                  color: v.color, fontWeight: 500, marginBottom: "5px",
                  textShadow: `0 0 20px ${v.color}44`,
                }}>{fmtINR(v.num)}</div>
                <div style={{ fontSize: "10px", color: "#4b6080" }}>
                  {v.key === "coast"
                    ? calc.coastReached
                      ? <span style={{ color: C.green }}>✓ Already achieved!</span>
                      : `Need ${fmtINR(v.num - calc.totalCorpusNow)} more`
                    : `Age ${Math.min(inputs.currentAge + v.yrs, 98)} · ${v.yrs >= 65 ? "65+ yrs" : `${v.yrs} yrs`}`
                  }
                </div>
                <div style={{ fontSize: "9px", color: "#2a3f5a", marginTop: "2px" }}>{v.desc}</div>
              </Card>
            ))}
          </div>

          {/* Progress bars */}
          <Card style={{ marginBottom: "14px" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "18px" }}>
              {[
                { label: "Progress to Regular FIRE", pct: calc.progress, lo: fmtINR(calc.totalCorpusNow), hi: fmtINR(calc.fireNumber), color: C.saffron, grad: "linear-gradient(90deg,#c2410c,#fb923c)" },
                { label: "Coast FIRE Progress", pct: calc.coastProgress, lo: fmtINR(calc.totalCorpusNow), hi: fmtINR(calc.coastFire), color: C.green, grad: "linear-gradient(90deg,#059669,#34d399)" },
              ].map((b) => (
                <div key={b.label}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
                    <SectionLabel>{b.label}</SectionLabel>
                    <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "11px", color: b.color }}>{b.pct.toFixed(1)}%</span>
                  </div>
                  <div style={{ height: "5px", background: "#1a2740", borderRadius: "3px", overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${Math.min(b.pct, 100)}%`, background: b.grad, borderRadius: "3px", transition: "width 0.7s cubic-bezier(0.4,0,0.2,1)", boxShadow: `0 0 8px ${b.color}55` }} />
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", marginTop: "4px" }}>
                    <span style={{ fontSize: "9px", color: "#4b6080" }}>Now: {b.lo}</span>
                    <span style={{ fontSize: "9px", color: "#2a3f5a" }}>Target: {b.hi}</span>
                  </div>
                </div>
              ))}
            </div>
          </Card>

          {/* Monte Carlo stats */}
          {showMC && mcData && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "10px", marginBottom: "14px" }}>
              {[
                {
                  label: "FIRE Success Rate",
                  value: `${mcData.successRate}%`,
                  sub: "250 Monte Carlo simulations",
                  color: mcData.successRate >= 80 ? C.green : mcData.successRate >= 60 ? C.saffron : C.red,
                },
                {
                  label: "Median Corpus at FIRE",
                  value: fmtINR(mcData.medianAtFire),
                  sub: "50th percentile scenario",
                  color: C.saffron,
                },
                {
                  label: "Bear Case (p10)",
                  value: fmtINR(mcData.worstAtFire),
                  sub: "Worst 10% of outcomes",
                  color: C.red,
                },
              ].map((s) => (
                <Card key={s.label} style={{ padding: "13px 15px", borderColor: `${s.color}22` }}>
                  <SectionLabel>{s.label}</SectionLabel>
                  <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "18px", color: s.color, fontWeight: 500 }}>{s.value}</div>
                  <div style={{ fontSize: "9px", color: "#2a3f5a", marginTop: "3px" }}>{s.sub}</div>
                </Card>
              ))}
            </div>
          )}

          {/* Chart */}
          <Card style={{ marginBottom: "14px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "14px" }}>
              <SectionLabel>
                Portfolio Projection · {showMC ? "Monte Carlo band (p10–p90)" : "Deterministic"} · Inflation-adjusted
              </SectionLabel>
              <div style={{ display: "flex", gap: "10px" }}>
                {[
                  { c: C.saffron, l: "Investments" },
                  { c: C.blue, l: "EPF" },
                  { c: C.green, l: "PPF" },
                  { c: C.purple, l: "NPS" },
                ].map(({ c, l }) => (
                  <div key={l} style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                    <div style={{ width: "6px", height: "6px", borderRadius: "50%", background: c }} />
                    <span style={{ fontSize: "9px", color: "#334155" }}>{l}</span>
                  </div>
                ))}
              </div>
            </div>
            <ResponsiveContainer width="100%" height={260}>
              <ComposedChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <defs>
                  {[["ga", C.saffron], ["gb", C.blue], ["gc", C.green], ["gd", C.purple]].map(([id, color]) => (
                    <linearGradient key={id} id={id} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={color} stopOpacity={0.15} />
                      <stop offset="95%" stopColor={color} stopOpacity={0} />
                    </linearGradient>
                  ))}
                </defs>

                <XAxis dataKey="age"
                  tick={{ fill: "#2a3f5a", fontSize: 10, fontFamily: "'JetBrains Mono', monospace" }}
                  axisLine={{ stroke: "#1a2740" }} tickLine={false} />
                <YAxis tickFormatter={fmtINR}
                  tick={{ fill: "#2a3f5a", fontSize: 10, fontFamily: "'JetBrains Mono', monospace" }}
                  axisLine={false} tickLine={false} width={74} />
                <Tooltip content={<Tip />} />

                {/* FIRE target line */}
                <ReferenceLine y={calc.fireNumber} stroke={C.saffron} strokeDasharray="5 4" strokeOpacity={0.35}
                  label={{ value: "FIRE", fill: C.saffron, fontSize: 9, fontFamily: "'JetBrains Mono', monospace" }} />
                {calc.yearsToFire < 65 && (
                  <ReferenceLine x={calc.retireAge} stroke={C.green} strokeDasharray="5 4" strokeOpacity={0.3}
                    label={{ value: `Age ${calc.retireAge}`, fill: C.green, fontSize: 9, position: "insideTopLeft", fontFamily: "'JetBrains Mono', monospace" }} />
                )}
                {inputs.emiYears > 0 && inputs.emiYears < 65 && (
                  <ReferenceLine x={inputs.currentAge + inputs.emiYears} stroke={C.teal} strokeDasharray="3 3" strokeOpacity={0.3}
                    label={{ value: "EMI✓", fill: C.teal, fontSize: 8, fontFamily: "'JetBrains Mono', monospace" }} />
                )}

                {/* MC band (stacked: transparent base + colored band) */}
                {showMC && mcData && <>
                  <Area type="monotone" dataKey="mcBase" stackId="mc" fill="transparent" stroke="none" legendType="none" />
                  <Area type="monotone" dataKey="mcBand" stackId="mc" fill="rgba(251,146,60,0.09)" stroke="none" legendType="none" />
                </>}

                {/* Main portfolio lines */}
                <Area type="monotone" dataKey="portfolio" stroke={C.saffron} strokeWidth={2}
                  fill="url(#ga)" dot={false} activeDot={{ r: 3, fill: C.saffron }} />
                <Area type="monotone" dataKey="epf" stroke={C.blue} strokeWidth={1.5}
                  fill="url(#gb)" dot={false} activeDot={{ r: 3, fill: C.blue }} />
                {(inputs.currentPPF > 0 || inputs.ppfAnnual > 0) && (
                  <Area type="monotone" dataKey="ppf" stroke={C.green} strokeWidth={1.5}
                    fill="url(#gc)" dot={false} activeDot={{ r: 3, fill: C.green }} />
                )}
                {(inputs.currentNPS > 0 || inputs.npsContrib > 0) && (
                  <Area type="monotone" dataKey="nps" stroke={C.purple} strokeWidth={1.5}
                    fill="url(#gd)" dot={false} activeDot={{ r: 3, fill: C.purple }} />
                )}
              </ComposedChart>
            </ResponsiveContainer>
          </Card>

          {/* Summary stats grid */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "10px", marginBottom: "14px" }}>
            {[
              { label: "Monthly take-home now", value: fmtINR(calc.postTaxIncome0 / 12), color: C.green },
              { label: "Monthly investable surplus", value: fmtINR(calc.netSavings0 / 12), color: C.saffron },
              { label: "Savings rate", value: `${calc.savingsRate0.toFixed(1)}%`, color: calc.savingsRate0 >= 40 ? C.green : calc.savingsRate0 >= 20 ? C.saffron : C.red },
              { label: "Real blended return", value: `~${(calc.realBlended * 100).toFixed(1)}% p.a.`, color: "#94a3b8" },
              { label: `Income at age 45 (est.)`, value: fmtINR(inputs.annualCTC * Math.pow(1 + inputs.incomeGrowthRate / 100, Math.max(0, 45 - inputs.currentAge)) / 12) + "/mo", color: "#94a3b8" },
              { label: "LTCG/yr at FIRE", value: fmtINR(calc.ltcgOnWithdrawal), color: C.red },
              { label: "EPF corpus at FIRE", value: fmtINR(calc.epfAtFire), color: C.blue },
              { label: "NPS at FIRE (60% liquid)", value: fmtINR(calc.npsAtFire * 0.6), color: C.purple },
            ].map((s) => (
              <Card key={s.label} style={{ padding: "12px 14px" }}>
                <div style={{ fontSize: "9px", color: "#334155", marginBottom: "5px" }}>{s.label}</div>
                <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "13px", color: s.color || "#e2e8f0" }}>{s.value}</div>
              </Card>
            ))}
          </div>

          {/* Key milestones */}
          <Card>
            <SectionLabel>FIRE Milestones</SectionLabel>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "12px" }}>
              {[
                { label: "Lean FIRE", age: `Age ${Math.min(inputs.currentAge + calc.leanYears, 98)}`, color: C.blue },
                { label: "Coast FIRE", age: calc.coastReached ? "Now ✓" : `~Age ${Math.min(inputs.currentAge + Math.ceil(Math.log(calc.coastFire / Math.max(calc.totalCorpusNow, 1)) / Math.log(1 + Math.max(calc.realBlended, 0.01))), 98)}`, color: C.green },
                { label: "Regular FIRE", age: `Age ${Math.min(calc.retireAge, 98)}`, color: C.saffron },
                { label: "Fat FIRE", age: `Age ${Math.min(inputs.currentAge + calc.fatYears, 98)}`, color: C.purple },
              ].map((m) => (
                <div key={m.label} style={{ textAlign: "center", padding: "8px", background: "#060d18", borderRadius: "6px" }}>
                  <div style={{ fontSize: "9px", color: "#334155", marginBottom: "4px" }}>{m.label}</div>
                  <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "13px", color: m.color }}>{m.age}</div>
                </div>
              ))}
            </div>
          </Card>

          <div style={{ marginTop: "14px", fontSize: "9px", color: "#1a2740", lineHeight: 1.8 }}>
            All figures in today's rupees (real returns). Income grows at your specified rate before tax each year. LTCG: 12.5% on equity gains above ₹1.25L/yr (Finance Act 2024). Debt MF taxed at marginal slab rate. EPF & PPF: EEE tax treatment. NPS: 60% tax-free lump sum + 40% mandatory annuity at exit. EPF employee contribution scales with income growth (capped ₹1.8L/yr). Healthcare premium inflated at 10% p.a. Monte Carlo: 250 runs, equity σ = ±17%, debt σ = ±3%. Coast FIRE assumes current corpus compounds at real blended return with no further contributions. Not financial advice — consult a SEBI-registered investment advisor.
          </div>
        </div>
      </div>
    </div>
  );
}