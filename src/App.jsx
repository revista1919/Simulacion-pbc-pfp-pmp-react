import React, { useEffect, useRef, useState, useMemo } from "react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  AreaChart,
  Area,
  BarChart,
  Bar,
  CartesianGrid,
  RadialBarChart,
  RadialBar,
  PieChart,
  Pie,
  Cell,
} from "recharts";

/*
  Simulador PBC - PFP - PMP — versión "Planificador Humano" (completa)
  - Recharts para gráficos
  - Editor visual de demanda (tipos + sliders)
  - Consumidores ocultos y estocásticos (reaccionan a variaciones de precio)
  - Empresas PBC/PFP/PMP con capacidades, inventarios, costos y adopción de innovaciones (delays)
  - Fases experimentales con distinta retroalimentación y volatilidad
  - Finalizar -> estadísticas exhaustivas + export JSON/CSV
  - Empezar "al tiro": la simulación inicia automáticamente

  Instalar deps:  npm install recharts
*/

// ------------------ UTILIDADES ------------------
function mulberry32(a) {
  return function () {
    var t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function randRange(rng, a, b) {
  return a + (b - a) * rng();
}
function clamp(x, a, b) {
  return Math.max(a, Math.min(b, x));
}
function last(arr, fallback = 0) {
  if (!arr || arr.length === 0) return fallback;
  return arr[arr.length - 1];
}
function olsLinear(x, y) {
  const n = x.length;
  if (n === 0) return { a: 0, b: 0 };
  const meanX = x.reduce((s, v) => s + v, 0) / n;
  const meanY = y.reduce((s, v) => s + v, 0) / n;
  let num = 0,
    den = 0;
  for (let i = 0; i < n; i++) {
    num += (x[i] - meanX) * (y[i] - meanY);
    den += (x[i] - meanX) ** 2;
  }
  const b = den === 0 ? 0 : num / den;
  const a = meanY - b * meanX;
  return { a, b };
}
function variance(arr) {
  if (!arr || arr.length === 0) return 0;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  return arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length;
}

// ------------------ DEMAND FACTORY (visual editor) ------------------
function createDemandFn(type, params) {
  if (type === "linear") {
    const { A = 100, B = 5 } = params;
    return (p) => Math.max(0, A - B * p);
  }
  if (type === "exp") {
    const { A = 100, B = 0.5 } = params;
    return (p) => Math.max(0, A * Math.exp(-B * p));
  }
  if (type === "log") {
    const { A = 100, B = 5 } = params;
    return (p) => Math.max(0, A - B * Math.log(1 + Math.max(0, p)));
  }
  if (type === "poly") {
    const { A = 100, B = 5, C = 0.01 } = params;
    return (p) => Math.max(0, A - B * p - C * p * p);
  }
  if (type === "logistic") {
    const { K = 100, mid = 2, steep = 1 } = params;
    return (p) => Math.max(0, K / (1 + Math.exp(steep * (p - mid))));
  }
  // fallback linear
  return (p) => Math.max(0, params.A - (params.B || 1) * p);
}

// ------------------ DEMAND PREVIEW SVG ------------------
function DemandPreviewSVG({ fn, maxP = 20, width = 260, height = 90 }) {
  const steps = 60;
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const p = (i / steps) * maxP;
    let q = 0;
    try {
      q = fn ? fn(p) : 0;
      if (!isFinite(q)) q = 0;
    } catch (e) {
      q = 0;
    }
    pts.push({ p, q: Math.max(0, q) });
  }
  const maxQ = Math.max(...pts.map((d) => d.q), 1);
  const maxPX = Math.max(...pts.map((d) => d.p), 1);
  const pointsStr = pts
    .map(
      (pt) => `${10 + (pt.p / maxPX) * (width - 40)},${
        height - 15 - (pt.q / maxQ) * (height - 40)
      }`
    )
    .join(" ");
  return (
    <svg
      width={width}
      height={height}
      style={{ background: "#fff", borderRadius: 6, border: "1px solid #e6e6e6" }}
    >
      <polyline fill="none" stroke="#2563eb" strokeWidth={2} points={pointsStr} />
      <text x={8} y={height - 2} fontSize={11} fill="#111">
        p →
      </text>
      <text x={width - 22} y={12} fontSize={11} fill="#111">
        q
      </text>
    </svg>
  );
}

// ------------------ DEFAULTS ------------------
const DEFAULT = {
  seed: 12345,
  consumersN: 350,
  p0: 1.0,
  tickMs: 700,
  pMin: 0.01,
  pPriceAdjustGain: 0.08,
  consumerUpdateRange: [30, 90],
  pbcCountRange: [3, 6],
  pfpCountRange: [3, 6],
  pmpCountRange: [2, 4],
  delays: { pbcToPfp: [5, 15], pfpToPmp: [5, 20], pmpAdjust: [10, 25] },
  innovation: {
    probPerTick: 0.03,
    costMultRange: [0.92, 0.99],
    tfpMultRange: [1.02, 1.25],
    adoptionRange: [10, 60],
  },
};

// Reacción de consumidores (configurable)
const CONSUMER_REACT_PROBS = { baja: 0.8, mantiene: 0.18, sube: 0.02 };
const CONSUMER_REACT_FACTORS = {
  baja: [0.7, 0.95],
  mantiene: [0.98, 1.02],
  sube: [1.01, 1.2],
};

// ------------------ SUBCOMPONENTES UI ------------------
function DemandEditorControls({
  demandType,
  setDemandType,
  dParams,
  setDParams,
  appliedDemandLabel,
  applyEditorDemand,
  revertToAuto,
}) {
  return (
    <div className="p-3 bg-white rounded border">
      <div className="font-semibold">Editor de demanda (planificador)</div>
      <div className="text-xs text-gray-600 mt-1">
        Selecciona el tipo y ajusta parámetros con los sliders. Pulsa <b>Aplicar</b> para
        que las PBC usen esta ecuación para planear.
      </div>
      <label className="block mt-2 text-sm">Tipo</label>
      <select
        value={demandType}
        onChange={(e) => setDemandType(e.target.value)}
        className="w-full p-1 border rounded"
      >
        <option value="linear">Lineal (A - B·p)</option>
        <option value="exp">Exponencial (A·exp(-B·p))</option>
        <option value="log">Logarítmica (A - B·log(1+p))</option>
        <option value="poly">Polinómica (A - B·p - C·p²)</option>
        <option value="logistic">Logística (K / (1 + e^{steep (p - mid)}))</option>
      </select>

      <div className="mt-2 space-y-2 text-sm">
        {demandType === "linear" && (
          <>
            <label className="text-xs">A (intercepto): {dParams.A.toFixed(1)}</label>
            <input
              type="range"
              min={0}
              max={400}
              step={1}
              value={dParams.A}
              onChange={(e) => setDParams((p) => ({ ...p, A: Number(e.target.value) }))}
            />
            <label className="text-xs">B (pendiente): {dParams.B.toFixed(2)}</label>
            <input
              type="range"
              min={0}
              max={20}
              step={0.1}
              value={dParams.B}
              onChange={(e) => setDParams((p) => ({ ...p, B: Number(e.target.value) }))}
            />
          </>
        )}
        {demandType === "exp" && (
          <>
            <label className="text-xs">A: {dParams.A.toFixed(1)}</label>
            <input
              type="range"
              min={0}
              max={400}
              step={1}
              value={dParams.A}
              onChange={(e) => setDParams((p) => ({ ...p, A: Number(e.target.value) }))}
            />
            <label className="text-xs">B: {dParams.B.toFixed(3)}</label>
            <input
              type="range"
              min={0.01}
              max={2}
              step={0.01}
              value={dParams.B}
              onChange={(e) => setDParams((p) => ({ ...p, B: Number(e.target.value) }))}
            />
          </>
        )}
        {demandType === "log" && (
          <>
            <label className="text-xs">A: {dParams.A.toFixed(1)}</label>
            <input
              type="range"
              min={0}
              max={400}
              step={1}
              value={dParams.A}
              onChange={(e) => setDParams((p) => ({ ...p, A: Number(e.target.value) }))}
            />
            <label className="text-xs">B: {dParams.B.toFixed(2)}</label>
            <input
              type="range"
              min={0}
              max={50}
              step={0.1}
              value={dParams.B}
              onChange={(e) => setDParams((p) => ({ ...p, B: Number(e.target.value) }))}
            />
          </>
        )}
        {demandType === "poly" && (
          <>
            <label className="text-xs">A: {dParams.A.toFixed(1)}</label>
            <input
              type="range"
              min={0}
              max={400}
              step={1}
              value={dParams.A}
              onChange={(e) => setDParams((p) => ({ ...p, A: Number(e.target.value) }))}
            />
            <label className="text-xs">B: {dParams.B.toFixed(2)}</label>
            <input
              type="range"
              min={0}
              max={20}
              step={0.1}
              value={dParams.B}
              onChange={(e) => setDParams((p) => ({ ...p, B: Number(e.target.value) }))}
            />
            <label className="text-xs">C (cuadrático): {dParams.C.toFixed(3)}</label>
            <input
              type="range"
              min={0}
              max={1}
              step={0.001}
              value={dParams.C}
              onChange={(e) => setDParams((p) => ({ ...p, C: Number(e.target.value) }))}
            />
          </>
        )}
        {demandType === "logistic" && (
          <>
            <label className="text-xs">K: {dParams.K.toFixed(1)}</label>
            <input
              type="range"
              min={0}
              max={400}
              step={1}
              value={dParams.K}
              onChange={(e) => setDParams((p) => ({ ...p, K: Number(e.target.value) }))}
            />
            <label className="text-xs">mid: {dParams.mid.toFixed(2)}</label>
            <input
              type="range"
              min={0}
              max={10}
              step={0.1}
              value={dParams.mid}
              onChange={(e) => setDParams((p) => ({ ...p, mid: Number(e.target.value) }))}
            />
            <label className="text-xs">steep: {dParams.steep.toFixed(2)}</label>
            <input
              type="range"
              min={0}
              max={5}
              step={0.05}
              value={dParams.steep}
              onChange={(e) => setDParams((p) => ({ ...p, steep: Number(e.target.value) }))}
            />
          </>
        )}
      </div>
      <div className="mt-3 flex gap-2">
        <button className="px-3 py-1 bg-green-600 text-white rounded" onClick={applyEditorDemand}>
          Aplicar (en vivo)
        </button>
        <button className="px-3 py-1 bg-gray-200 rounded" onClick={revertToAuto}>
          Revertir a automático
        </button>
      </div>
      <div className="mt-3">
        <div className="text-xs">Previsualización</div>
        <div className="mt-2">
          <DemandPreviewSVG fn={createDemandFn(demandType, dParams)} maxP={Math.max(10, dParams.A / Math.max(1, dParams.B || 1))} />
        </div>
        <div className="text-xs mt-1 text-gray-600">
          Aplicado: <b>{appliedDemandLabel}</b>
        </div>
      </div>
    </div>
  );
}

function MiniGuide() {
  return (
    <div className="bg-white p-3 rounded border text-sm">
      <div className="font-semibold">Mini‑guía (rápida)</div>
      <ol className="mt-2 list-decimal list-inside text-xs text-gray-700 space-y-1">
        <li>
          <b>Editor de demanda:</b> Elige tipo y ajusta parámetros. Pulsa <em>Aplicar</em> para que las PBC usen esa
          ecuación como percepción de demanda.
        </li>
        <li>
          <b>Simulación:</b> corre en tiempo real. Consumidores reales están ocultos y reaccionan estocásticamente.
        </li>
        <li>
          <b>Precio:</b> Automático (feedback oferta/demanda) o Manual (fijo por ti).
        </li>
        <li>
          <b>Ticker:</b> pedidos, innovaciones y adopciones. Útil para diagnóstico.
        </li>
        <li>
          <b>Finalizar:</b> detiene y calcula métricas (regret, welfare proxy, volatilidades). Exporta JSON/CSV.
        </li>
      </ol>
      <div className="mt-2 text-xs text-gray-500">Tip: empieza con Lineal A=120, B=6 para dinámica estable.</div>
    </div>
  );
}

// ------------------ APP ------------------
export default function App() {
  // rng / simRef
  const [seed, setSeed] = useState(DEFAULT.seed);
  const rngRef = useRef(mulberry32(seed));
  const simRef = useRef(null);

  // UI reactive state
  const [running, setRunning] = useState(true);
  const [tickMs, setTickMs] = useState(DEFAULT.tickMs);
  const [historyLen, setHistoryLen] = useState(200);
  const [seriesData, setSeriesData] = useState([]); // time series for charts
  const [events, setEvents] = useState([]);
  const [phaseIdx, setPhaseIdx] = useState(0);
  const EXPERIMENT_PHASES = [
    { name: "A", feedbackStrength: 0.05, volatility: 0.02, desc: "Cambios lentos" },
    { name: "B", feedbackStrength: 0.12, volatility: 0.12, desc: "Cambios rápidos" },
    { name: "C", feedbackStrength: 0.4, volatility: 0.12, desc: "Retroalimentación fuerte" },
  ];

  // Demand editor (planner)
  const [demandType, setDemandType] = useState("linear");
  const [dParams, setDParams] = useState({ A: 120, B: 6, C: 0.01, K: 120, mid: 2, steep: 1 });
  const [userDemandFn, setUserDemandFn] = useState(null); // function used by PBC to plan
  const [appliedDemandLabel, setAppliedDemandLabel] = useState("Automático");

  // Precio
  const [priceMode, setPriceMode] = useState("auto"); // auto | manual
  const [manualPrice, setManualPrice] = useState(DEFAULT.p0);

  // finalization
  const [finished, setFinished] = useState(false);
  const [finalStats, setFinalStats] = useState(null);

  // counters for innovation
  const innovationCounterRef = useRef({ scheduled: 0, adopted: 0 });

  // KPIs en vivo (derivados)
  const kpis = useMemo(() => {
    const w = seriesData.slice(-40);
    const avgEff = w.length ? w.reduce((a, b) => a + (b.efficiency || 0), 0) / w.length : 0;
    const priceVar = variance(w.map((d) => d.price));
    const demandVar = variance(w.map((d) => d.qDemand));
    const utilization = w.length ? (w.reduce((a, b) => a + (b.qServed || 0), 0) / (w.reduce((a, b) => a + (b.qDemand || 0), 0) || 1)) : 0;
    return { avgEff, priceVar, demandVar, utilization };
  }, [seriesData]);

  // ------------------ init ------------------
  function initSimulation(newSeed = seed) {
    const rng = mulberry32(newSeed);
    rngRef.current = rng;
    const s = {
      t: 0,
      seed: newSeed,
      rng,
      price: DEFAULT.p0,
      consumers: [],
      firms: { PBC: [], PFP: [], PMP: [] },
      orders: [],
      logs: [],
      userPerceivedDemandFn: null,
      innovations: [],
    };

    // create consumers (ocultos)
    for (let i = 0; i < DEFAULT.consumersN; i++) {
      const typeRand = rng();
      let type = "linear";
      if (typeRand < 0.6) type = "linear";
      else if (typeRand < 0.85) type = "log";
      else if (typeRand < 0.98) type = "exp";
      else type = "poly";

      // Se asignan valores iniciales a y b
      const a = randRange(rng, 5, 200);
      const signRoll = rng();
      let b = 0;
      if (signRoll < 0.75) b = randRange(rng, 0.01, 10);
      else if (signRoll < 0.95) b = 0;
      else b = -randRange(rng, 0.1, 5);
      
      // Se agrega la propiedad nextChange para cambios de preferencias
      const nextChange = Math.floor(randRange(rng, 0, 50));

      const Ti = Math.round(randRange(rng, DEFAULT.consumerUpdateRange[0], DEFAULT.consumerUpdateRange[1]));
      s.consumers.push({ id: `C${i}`, type, a, b, Ti, nextUpdateAt: Ti, lastUpdate: 0, nextChange });
    }

    // create firms
    const pbcCount = Math.round(
      randRange(rng, DEFAULT.pbcCountRange[0], DEFAULT.pbcCountRange[1])
    );
    for (let i = 0; i < pbcCount; i++)
      s.firms.PBC.push({
        id: `PBC${i}`,
        A: randRange(rng, 0.8, 1.3),
        capacity: randRange(rng, 10, 50),
        marginalCost: randRange(rng, 0.2, 1.0),
        inventory: 0,
        planned: 0,
        history: [],
      });

    const pfpCount = Math.round(
      randRange(rng, DEFAULT.pfpCountRange[0], DEFAULT.pfpCountRange[1])
    );
    for (let i = 0; i < pfpCount; i++)
      s.firms.PFP.push({
        id: `PFP${i}`,
        A: randRange(rng, 0.8, 1.3),
        capacity: randRange(rng, 10, 80),
        marginalCost: randRange(rng, 0.1, 0.8),
        inventory: 0,
        history: [],
      });

    const pmpCount = Math.round(
      randRange(rng, DEFAULT.pmpCountRange[0], DEFAULT.pmpCountRange[1])
    );
    for (let i = 0; i < pmpCount; i++)
      s.firms.PMP.push({
        id: `PMP${i}`,
        A: randRange(rng, 0.8, 1.3),
        capacity: randRange(rng, 30, 140),
        marginalCost: randRange(rng, 0.05, 0.6),
        inventory: 0,
        history: [],
      });

    // aproximar p0 para evitar desequilibrio inicial muy grande
    let p0 = DEFAULT.p0;
    for (let iter = 0; iter < 40; iter++) {
      let Qagg = 0;
      for (const c of s.consumers) Qagg += computeConsumerDemand(c, p0, rng);
      const oferta = Math.max(1, s.firms.PBC.reduce((acc, f) => acc + (f.capacity || 0), 0));
      if (Math.abs(Qagg - oferta) < 1e-2 * Math.max(1, oferta)) break;
      if (Qagg > oferta) p0 *= 1.05;
      else p0 *= 0.95;
    }
    s.price = p0;

    simRef.current = s;
    innovationCounterRef.current = { scheduled: 0, adopted: 0 };

    setSeriesData([{ t: 0, price: s.price, qDemand: 0, qServed: 0, efficiency: 1 }]);
    setEvents((ev) => [`Simulación inicializada (seed ${newSeed})`, ...ev].slice(0, 30));
    setFinished(false);
    setFinalStats(null);
    setAppliedDemandLabel("Automático");
    setUserDemandFn(null);
  }

  // consumer demand & reaction
  function computeConsumerDemand(c, p, rng) {
    let q = 0;
    if (c.type === "linear") q = c.a - c.b * p;
    else if (c.type === "log") q = c.a - c.b * Math.log(1 + Math.max(0, p));
    else if (c.type === "exp") q = c.a * Math.exp(-c.b * p);
    else if (c.type === "poly") {
      const cc = Math.max(0.001, c.b * 0.01);
      q = Math.max(0, c.a - c.b * p - cc * p * p);
    }
    const noiseSigma = 0.05;
    const noise = 1 + (rng() - 0.5) * 2 * noiseSigma;
    return Math.max(0, q * noise);
  }
  function consumerReact(prevPrice, newPrice, rng) {
    if (newPrice === prevPrice) return 1;
    const up = newPrice > prevPrice;
    const roll = rng();
    if (up) {
      if (roll < CONSUMER_REACT_PROBS.baja) return randRange(rng, ...CONSUMER_REACT_FACTORS.baja);
      if (roll < CONSUMER_REACT_PROBS.baja + CONSUMER_REACT_PROBS.mantiene)
        return randRange(rng, ...CONSUMER_REACT_FACTORS.mantiene);
      return randRange(rng, ...CONSUMER_REACT_FACTORS.sube);
    } else {
      if (roll < 0.7) return randRange(rng, 1.01, 1.2);
      if (roll < 0.95) return randRange(rng, 0.98, 1.02);
      return randRange(rng, 0.7, 0.95);
    }
  }

  // ---------- CORE SIM TICK ----------
  function simTick() {
    const s = simRef.current;
    if (!s) return;
    const rng = s.rng;
    s.t = (s.t || 0) + 1;

    const prevPrice = s.price;
    // manual price override
    if (priceMode === "manual") s.price = Math.max(DEFAULT.pMin, manualPrice);

    // consumers update
    let Qagg = 0;
    for (const c of s.consumers) {
      // Si se supera el instante para cambio de preferencias, actualizamos type y coeficientes
      if (s.t >= c.nextChange) {
        const r = rng();
        if (r < 0.33) {
          c.type = "linear";
          c.a = randRange(rng, 100, 150);
          c.b = randRange(rng, 0.5, 1.0);
        } else if (r < 0.66) {
          c.type = "log";
          c.a = randRange(rng, 80, 120);
          c.b = randRange(rng, 5, 10);
        } else {
          c.type = "exp";
          c.a = randRange(rng, 90, 120);
          c.b = randRange(rng, 0.1, 0.3);
        }
        c.nextChange = s.t + 30 + Math.floor(randRange(rng, 0, 70));
      }
      
      if (s.t >= c.nextUpdateAt) {
        if (rng() < 0.15) {
          c.a = randRange(rng, 5, 200);
          const signRoll = rng();
          if (signRoll < 0.75) c.b = randRange(rng, 0.01, 10);
          else if (signRoll < 0.95) c.b = 0;
          else c.b = -randRange(rng, 0.1, 5);
        } else {
          c.a *= 1 + (rng() - 0.5) * 0.08;
          c.b *= 1 + (rng() - 0.5) * 0.04;
        }
        if (rng() < 0.01) c.a *= randRange(rng, 1.5, 3.0);
        c.nextUpdateAt =
          s.t + Math.round(randRange(rng, DEFAULT.consumerUpdateRange[0], DEFAULT.consumerUpdateRange[1]));
        c.lastUpdate = s.t;
      }
      // pequeñas variaciones
      c.a += (rng() - 0.5) * 0.01 * c.a;
      c.b += (rng() - 0.5) * 0.01 * c.b;
      // feedback experimental
      const phase = EXPERIMENT_PHASES[phaseIdx];
      if (phase.feedbackStrength) c.a += phase.feedbackStrength * (prevPrice - s.price);

      let baseQ = computeConsumerDemand(c, s.price, rng);
      const reactFactor = consumerReact(prevPrice, s.price, rng);
      baseQ *= reactFactor;
      Qagg += baseQ;
    }

    // perceived demand usada por PBC (si el usuario definió fn la usaremos)
    const perceivedFn = userDemandFn ? userDemandFn : (p) => Qagg * (0.85 + 0.3 * rng());

    // PBC planning: comparten carga por capacidad*eficiencia A
    const sumA = Math.max(
      1e-6,
      s.firms.PBC.reduce((acc, f) => acc + (f.A * (f.capacity || 1)), 0)
    );
    for (const f of s.firms.PBC) {
      const share = (f.A * (f.capacity || 1)) / sumA;
      const plan = Math.max(0, perceivedFn(s.price)) * share;
      f.planned = plan;
      // si plan necesita insumos -> pedido a PFP
      if (plan > f.inventory) {
        const needed = plan - f.inventory;
        const pfp = s.firms.PFP[Math.floor(rng() * s.firms.PFP.length)];
        if (pfp) {
          const delay = Math.round(randRange(rng, DEFAULT.delays.pbcToPfp[0], DEFAULT.delays.pbcToPfp[1]));
          s.orders.push({ level: "PBC->PFP", from: f.id, to: pfp.id, amount: needed, due: s.t + delay });
        }
      }
    }

    // PFP y PMP producen algo base (capacidad * factor aleatorio)
    for (const pmp of s.firms.PMP) {
      const produced = (pmp.capacity || 10) * (0.4 + rng() * 0.6);
      pmp.inventory = (pmp.inventory || 0) + produced;
      pmp.history = pmp.history || [];
      pmp.history.push({ t: s.t, produced });
    }
    for (const pfp of s.firms.PFP) {
      const produced = (pfp.capacity || 10) * (0.4 + rng() * 0.6);
      pfp.inventory = (pfp.inventory || 0) + produced;
      pfp.history = pfp.history || [];
      pfp.history.push({ t: s.t, produced });
    }

    // procesar órdenes vencidas
    for (const ord of s.orders.filter((o) => !o.filled && o.due <= s.t).slice()) {
      if (ord.level === "PBC->PFP") {
        const pfp = s.firms.PFP.find((x) => x.id === ord.to);
        const pbc = s.firms.PBC.find((x) => x.id === ord.from);
        if (!pfp || !pbc) {
          ord.filled = true;
          continue;
        }
        if ((pfp.inventory || 0) >= ord.amount) {
          pfp.inventory -= ord.amount;
          pbc.inventory = (pbc.inventory || 0) + ord.amount;
          ord.filled = true;
          s.logs.push({ t: s.t, type: "order_filled", detail: ord });
          setEvents((ev) => [`Pedido ${ord.from}→${ord.to} servido`, ...ev].slice(0, 30));
        } else {
          // PFP pide a PMP
          const need = Math.max(0, ord.amount - (pfp.inventory || 0));
          const pmp = s.firms.PMP[Math.floor(rng() * s.firms.PMP.length)];
          if (pmp) {
            const delay = Math.round(randRange(rng, DEFAULT.delays.pfpToPmp[0], DEFAULT.delays.pfpToPmp[1]));
            s.orders.push({ level: "PFP->PMP", from: pfp.id, to: pmp.id, amount: need, due: s.t + delay, orig: ord });
            setEvents((ev) => [`${pfp.id} pide a ${pmp.id}`, ...ev].slice(0, 30));
          }
        }
      } else if (ord.level === "PFP->PMP") {
        const pmp = s.firms.PMP.find((x) => x.id === ord.to);
        const pfp = s.firms.PFP.find((x) => x.id === ord.from);
        if (!pmp || !pfp) {
          ord.filled = true;
          continue;
        }
        if ((pmp.inventory || 0) >= ord.amount) {
          pmp.inventory -= ord.amount;
          pfp.inventory = (pfp.inventory || 0) + ord.amount;
          ord.filled = true;
          s.logs.push({ t: s.t, type: "order_filled", detail: ord });
          if (ord.orig) {
            const orig = ord.orig;
            const pbc = s.firms.PBC.find((x) => x.id === orig.from);
            if (pfp.inventory >= orig.amount && pbc) {
              pfp.inventory -= orig.amount;
              pbc.inventory = (pbc.inventory || 0) + orig.amount;
              orig.filled = true;
              setEvents((ev) => [`Orden original ${orig.from} completada`, ...ev].slice(0, 30));
            }
          }
        }
      }
    }

    // PBC sirven a clientes (limitadas por inventario y capacidad)
    let Qserved = 0;
    for (const f of s.firms.PBC) {
      const possible = Math.min(f.planned || 0, f.inventory || 0, f.capacity || 9999);
      const produced = Math.max(0, possible);
      f.inventory = (f.inventory || 0) - produced;
      Qserved += produced;
      f.history = f.history || [];
      f.history.push({ t: s.t, produced });
    }

    // Ajuste automático del precio
    if (priceMode === "auto") {
      const adjustGain = DEFAULT.pPriceAdjustGain;
      const delta = Qagg === 0 ? 0 : (Qagg - Qserved) / Math.max(1, Qagg);
      s.price = Math.max(DEFAULT.pMin, s.price * (1 + adjustGain * delta));
    }

    // Innovaciones aleatorias programadas
    if (rng() < DEFAULT.innovation.probPerTick) {
      const levels = ["PBC", "PFP", "PMP"];
      const level = levels[Math.floor(rng() * levels.length)];
      const firms = s.firms[level];
      if (firms && firms.length > 0) {
        const f = firms[Math.floor(rng() * firms.length)];
        const costMul = randRange(
          rng,
          DEFAULT.innovation.costMultRange[0],
          DEFAULT.innovation.costMultRange[1]
        );
        const tfpMul = randRange(
          rng,
          DEFAULT.innovation.tfpMultRange[0],
          DEFAULT.innovation.tfpMultRange[1]
        );
        const adopt = Math.round(
          randRange(rng, DEFAULT.innovation.adoptionRange[0], DEFAULT.innovation.adoptionRange[1])
        );
        const innov = {
          firm: f.id,
          level,
          costMul,
          tfpMul,
          scheduleAt: s.t,
          adoptAt: s.t + adopt,
          adopted: false,
        };
        s.innovations.push(innov);
        innovationCounterRef.current.scheduled += 1;
        setEvents((ev) => [`Innovación programada ${f.id} (${level})`, ...ev].slice(0, 30));
      }
    }

    // adopción
    if (s.innovations && s.innovations.length > 0) {
      for (const innov of s.innovations.filter((x) => !x.adopted && x.adoptAt <= s.t)) {
        const lvl = innov.level;
        const firm = s.firms[lvl].find((x) => x.id === innov.firm);
        if (firm) {
          firm.marginalCost = Math.max(0.01, firm.marginalCost * innov.costMul);
          firm.A = (firm.A || 1) * innov.tfpMul;
          innov.adopted = true;
          innovationCounterRef.current.adopted += 1;
          setEvents((ev) => [`${firm.id} adoptó innovación (${lvl})`, ...ev].slice(0, 30));
          s.logs.push({ t: s.t, type: "innovation_adopted", firm: firm.id, detail: innov });
        }
      }
    }

    // record new series point
    const point = {
      t: s.t,
      price: Number(s.price.toFixed(4)),
      qDemand: Number(Qagg.toFixed(3)),
      qServed: Number(Qserved.toFixed(3)),
      efficiency: Number((Qserved / Math.max(1, Qagg)).toFixed(3)),
    };
    setSeriesData((prev) => {
      const next = prev.concat(point);
      if (next.length > historyLen) next.splice(0, next.length - historyLen);
      return next;
    });

    // logs trimming
    if ((s.logs || []).length > 5000) s.logs = s.logs.slice(-2000);
  }

  // Empezar automáticamente
  useEffect(() => {
    initSimulation(seed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Intervalo de simulación
  useEffect(() => {
    let id = null;
    if (running && !finished) {
      id = setInterval(() => {
        try {
          simTick();
        } catch (err) {
          console.error("simTick error", err);
        }
      }, tickMs);
    }
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, tickMs, priceMode, manualPrice, phaseIdx, userDemandFn, finished]);

  // APPLY demand from editor: PBCs usarán esta fn
  function applyEditorDemand() {
    const fn = createDemandFn(demandType, dParams);
    setUserDemandFn(() => fn);
    setAppliedDemandLabel(
      `${demandType} (${Object.entries(dParams)
        .map(([k, v]) => `${k}=${Number(v).toFixed(2)}`)
        .join(", ")})`
    );
    setEvents((ev) => [`Planificador aplicó demanda: ${demandType}`, ...ev].slice(0, 30));
  }
  function revertToAuto() {
    setUserDemandFn(null);
    setAppliedDemandLabel("Automático");
    setEvents((ev) => ["Planificador volvió a automático", ...ev].slice(0, 30));
  }

  // ---------- ORACLE & WELFARE ----------
  function oracleDemandAt(p) {
    const s = simRef.current;
    if (!s) return 0;
    let Q = 0;
    for (const c of s.consumers) {
      let q = 0;
      if (c.type === "linear") q = Math.max(0, c.a - c.b * p);
      else if (c.type === "log") q = Math.max(0, c.a - c.b * Math.log(1 + Math.max(0, p)));
      else if (c.type === "exp") q = Math.max(0, c.a * Math.exp(-c.b * p));
      else if (c.type === "poly") {
        const cc = Math.max(0.001, c.b * 0.01);
        q = Math.max(0, c.a - c.b * p - cc * p * p);
      }
      Q += q;
    }
    return Q;
  }

  function aggregateWillingnessToPay(pricePoint) {
    const s = simRef.current;
    if (!s) return 0;
    const avgA = s.consumers.reduce((a, b) => a + b.a, 0) / Math.max(1, s.consumers.length || 1);
    const Pmax = Math.max(10, (avgA / Math.max(0.1, 1)) * 0.5);
    const steps = 100;
    let area = 0;
    for (let i = 0; i < steps; i++) {
      const p1 = (i / steps) * Pmax;
      const p2 = ((i + 1) / steps) * Pmax;
      const q1 = oracleDemandAt(p1);
      const q2 = oracleDemandAt(p2);
      area += 0.5 * (q1 + q2) * (p2 - p1);
    }
    return area - pricePoint * oracleDemandAt(pricePoint); // excedente aproximado a ese precio
  }

  // Finalizar y producir stats + exports
  function finalizeSession() {
    setRunning(false);
    setFinished(true);
    const s = simRef.current;
    const data = [...seriesData];
    const avgPrice = data.reduce((a, b) => a + b.price, 0) / Math.max(1, data.length);
    const avgDemand = data.reduce((a, b) => a + b.qDemand, 0) / Math.max(1, data.length);
    const avgServed = data.reduce((a, b) => a + b.qServed, 0) / Math.max(1, data.length);
    const effMean = data.reduce((a, b) => a + (b.efficiency || 0), 0) / Math.max(1, data.length);
    const demandVol = variance(data.map((d) => d.qDemand));
    const priceVol = variance(data.map((d) => d.price));

    const regretSeries = data.map((pt) => Math.abs(pt.qServed - oracleDemandAt(pt.price)));
    const cumulativeRegret = regretSeries.reduce((a, b) => a + b, 0);

    let welfareProxy = 0;
    for (const pt of data) {
      const wtp = aggregateWillingnessToPay(pt.price);
      const expenditure = pt.price * pt.qServed;
      welfareProxy += wtp - expenditure;
    }

    const innovationCounts = innovationCounterRef.current;
    const stats = {
      ticks: data.length,
      avgPrice,
      avgDemand,
      avgServed,
      effMean,
      demandVol,
      priceVol,
      cumulativeRegret,
      welfareProxy,
      innovationCounts,
      seed: s.seed,
    };
    setFinalStats(stats);
    setEvents((ev) => [`Sesión finalizada (ticks=${data.length}).`, ...ev].slice(0, 30));
  }

  // export JSON/CSV
  function exportJSON() {
    const s = simRef.current;
    const payload = { meta: { seed: s.seed }, series: seriesData, logs: s.logs || [], consumers: s.consumers };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `sim_${s.seed}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }
  function exportCSV() {
    const rows = [["t", "price", "qDemand", "qServed", "efficiency"]];
    for (const r of seriesData) rows.push([r.t, r.price, r.qDemand, r.qServed, r.efficiency]);
    const csv = rows.map((rr) => rr.join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `sim_series_${simRef.current?.seed || "run"}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // OLS rápida (encuesta) para ajustar percepción
  function olsSurvey(sampleSize = 30) {
    const s = simRef.current;
    const rng = s.rng;
    const ps = [];
    const qs = [];
    for (let i = 0; i < sampleSize; i++) {
      const p = randRange(rng, 0.5, Math.max(2, dParams.A / Math.max(0.1, dParams.B || 1)));
      let q = 0;
      for (const c of s.consumers.slice(0, Math.min(60, s.consumers.length))) q += computeConsumerDemand(c, p, rng);
      q *= 1 + (rng() - 0.5) * 0.2; // ruido observacional
      ps.push(p);
      qs.push(q);
    }
    return olsLinear(ps, qs);
  }

  // Recomendaciones en vivo
  const tips = useMemo(() => {
    const arr = [];
    if (kpis.avgEff < 0.7) arr.push("Eficiencia baja: considera bajar el precio o aumentar capacidad PBC.");
    if (kpis.priceVar > 0.15) arr.push("Precio muy volátil: fija precio manual temporalmente para estabilizar.");
    if (kpis.utilization < 0.8) arr.push("Subutilización: tal vez tu demanda percibida es muy baja. Aumenta A o baja B.");
    if (innovationCounterRef.current.scheduled > innovationCounterRef.current.adopted)
      arr.push("Hay innovaciones pendientes: espera adopción o acelera pedidos para aprovechar.");
    if (arr.length === 0) arr.push("Todo estable. Explora Fase C para estresar el sistema.");
    return arr;
  }, [kpis, innovationCounterRef.current.scheduled, innovationCounterRef.current.adopted]);

  // UI values
  const lastPoint = last(seriesData, { price: DEFAULT.p0, qDemand: 0, qServed: 0, efficiency: 1 });
  const currentTick = last(seriesData)?.t ?? 0;

  // ------------------ RENDER ------------------
  return (
    <div className="min-h-screen p-4 bg-gray-50 text-gray-900">
      <div className="max-w-7xl mx-auto space-y-4">
        <header className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">Simulador: Planificador Humano — PBC/PFP/PMP</h1>
          <div className="flex items-center gap-3">
            <div className="text-sm">
              Tick: <b>{currentTick}</b>
            </div>
            <div className="text-sm">
              Precio: <b>{Number(lastPoint.price || 0).toFixed(3)}</b>
            </div>
            <div className="text-sm">
              Eficiencia: <b>{((lastPoint.efficiency || 0) * 100).toFixed(1)}%</b>
            </div>
            <button className="px-3 py-1 bg-blue-600 text-white rounded" onClick={() => setRunning((r) => !r)}>
              {running ? "Pausar" : "Continuar"}
            </button>
            <button className="px-3 py-1 bg-red-500 text-white rounded" onClick={() => finalizeSession()}>
              Finalizar
            </button>
          </div>
        </header>

        <div className="grid grid-cols-12 gap-4">
          {/* LEFT */}
          <aside className="col-span-3 space-y-3">
            <div className="bg-white p-3 rounded border">
              <div className="font-semibold">Velocidad & Precio</div>
              <div className="text-xs text-gray-600 mt-1">Ajusta velocidad y modo de precio.</div>
              <div className="mt-2">
                <label className="text-xs">ms por tick: {tickMs}</label>
                <input
                  type="range"
                  min={200}
                  max={2000}
                  step={100}
                  value={tickMs}
                  onChange={(e) => setTickMs(Number(e.target.value))}
                />
              </div>
              <div className="mt-2">
                <label className="text-xs">Modo precio</label>
                <div className="flex gap-2 mt-1">
                  <label>
                    <input type="radio" name="pm" checked={priceMode === "auto"} onChange={() => setPriceMode("auto")} />
                    <span className="ml-1">Auto</span>
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="pm"
                      checked={priceMode === "manual"}
                      onChange={() => setPriceMode("manual")}
                    />
                    <span className="ml-1">Manual</span>
                  </label>
                </div>
                {priceMode === "manual" && (
                  <div className="mt-2">
                    <input
                      type="number"
                      step="0.01"
                      min="0.01"
                      value={manualPrice}
                      onChange={(e) => setManualPrice(Number(e.target.value))}
                      className="w-full p-1 border rounded"
                    />
                  </div>
                )}
              </div>
            </div>

            <DemandEditorControls
              demandType={demandType}
              setDemandType={setDemandType}
              dParams={dParams}
              setDParams={setDParams}
              appliedDemandLabel={appliedDemandLabel}
              applyEditorDemand={applyEditorDemand}
              revertToAuto={revertToAuto}
            />

            <div className="bg-white p-3 rounded border">
              <div className="font-semibold">Fase del experimento</div>
              <div className="text-xs text-gray-600 mt-1">Controla la fuerza de retroalimentación y volatilidad.</div>
              <div className="mt-2 flex gap-2">
                {EXPERIMENT_PHASES.map((ph, idx) => (
                  <button
                    key={ph.name}
                    onClick={() => setPhaseIdx(idx)}
                    className={`px-2 py-1 rounded border ${
                      phaseIdx === idx ? "bg-indigo-600 text-white" : "bg-gray-50"
                    }`}
                    title={ph.desc}
                  >
                    {ph.name}
                  </button>
                ))}
              </div>
            </div>

            <div className="bg-white p-3 rounded border">
              <div className="font-semibold">Ticker de eventos</div>
              <div className="text-xs text-gray-600 mt-2">Eventos recientes</div>
              <ul className="mt-2 text-sm" style={{ maxHeight: 220, overflowY: "auto" }}>
                {events.length === 0 ? (
                  <li className="text-gray-400">Sin eventos</li>
                ) : (
                  events.map((e, i) => <li key={i}>• {e}</li>)
                )}
              </ul>
            </div>

            <MiniGuide />
          </aside>

          {/* RIGHT */}
          <main className="col-span-9 space-y-4">
            <section className="bg-white p-3 rounded border">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="font-semibold">Series en tiempo real</h2>
                  <div className="text-xs text-gray-600">
                    Precio, demanda agregada (oculta) y cantidad servida por PBC.
                  </div>
                </div>
                <div className="flex gap-2">
                  <button
                    className="px-2 py-1 bg-gray-200 rounded"
                    onClick={() => setHistoryLen((h) => Math.max(40, h - 40))}
                  >
                    − ventana
                  </button>
                  <button
                    className="px-2 py-1 bg-gray-200 rounded"
                    onClick={() => setHistoryLen((h) => Math.min(1200, h + 40))}
                  >
                    + ventana
                  </button>
                </div>
              </div>

              <div className="mt-3 grid grid-cols-2 gap-4">
                <div style={{ width: "100%", height: 280, background: "#fff", borderRadius: 6 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={seriesData}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="t" />
                      <YAxis />
                      <Tooltip />
                      <Legend />
                      <Line type="monotone" dataKey="price" stroke="#ef4444" dot={false} name="Precio" strokeWidth={2} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
                <div style={{ width: "100%", height: 280, background: "#fff", borderRadius: 6 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={seriesData}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="t" />
                      <YAxis />
                      <Tooltip />
                      <Legend />
                      <Line type="monotone" dataKey="qDemand" stroke="#3b82f6" dot={false} name="Demanda real" strokeWidth={2} />
                      <Line type="monotone" dataKey="qServed" stroke="#16a34a" dot={false} name="Servida (PBC)" strokeWidth={2} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
                <div style={{ width: "100%", height: 220, background: "#fff", borderRadius: 6 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={seriesData}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="t" />
                      <YAxis />
                      <Tooltip />
                      <Area type="monotone" dataKey="efficiency" stroke="#7c3aed" fill="#c4b5fd" name="Eficiencia" />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
                <div style={{ width: "100%", height: 220, background: "#fff", borderRadius: 6 }} className="p-2">
                  <div className="font-semibold">Oferta vs Demanda (Último)</div>
                  <div className="text-xs text-gray-600">Comparación puntual</div>
                  <div style={{ width: "100%", height: 150 }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={[{ name: "Último", Oferta: lastPoint.qServed || 0, Demanda: lastPoint.qDemand || 0 }] }>
                        <XAxis dataKey="name" />
                        <YAxis />
                        <Tooltip />
                        <Bar dataKey="Oferta" fill="#16a34a" />
                        <Bar dataKey="Demanda" fill="#3b82f6" />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              </div>
            </section>

            {/* KPIs & gauges */}
            <section className="bg-white p-3 rounded border">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="font-semibold">Panel de salud del sistema</h3>
                  <div className="text-xs text-gray-600">KPIs en la ventana reciente</div>
                </div>
                <div className="flex gap-2">
                  <button
                    className="px-3 py-1 bg-gray-200 rounded"
                    onClick={() => {
                      const r = olsSurvey(40);
                      alert(`OLS: a=${r.a.toFixed(2)}, b=${r.b.toFixed(3)}`);
                    }}
                  >
                    Encuesta OLS
                  </button>
                  <button className="px-3 py-1 bg-gray-200 rounded" onClick={() => exportJSON()}>
                    Export JSON
                  </button>
                  <button className="px-3 py-1 bg-gray-200 rounded" onClick={() => exportCSV()}>
                    Export CSV
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-4 gap-3 mt-3">
                <KpiCard label="Eficiencia media" value={`${(kpis.avgEff * 100).toFixed(1)}%`} />
                <KpiCard label="Var. Precio (ventana)" value={kpis.priceVar.toFixed(3)} />
                <KpiCard label="Var. Demanda (ventana)" value={kpis.demandVar.toFixed(3)} />
                <KpiCard label="Utilización" value={`${(kpis.utilization * 100).toFixed(1)}%`} />
              </div>

              <div className="grid grid-cols-3 gap-4 mt-4">
                <div className="p-3 bg-gray-50 rounded">
                  <div className="text-xs text-gray-600">Sentimiento consumidores ante el último cambio</div>
                  <ResponsiveContainer width="100%" height={200}>
                    <RadialBarChart
                      innerRadius="30%"
                      outerRadius="100%"
                      data={[
                        { name: "Satisfacción", value: Math.max(1, Math.round(lastPoint.efficiency * 100)) },
                      ]}
                      startAngle={180}
                      endAngle={0}
                    >
                      <RadialBar minAngle={15} background dataKey="value" />
                      <Legend iconSize={10} layout="vertical" verticalAlign="middle" />
                    </RadialBarChart>
                  </ResponsiveContainer>
                </div>
                <div className="p-3 bg-gray-50 rounded">
                  <div className="text-xs text-gray-600">Composición de firmas</div>
                  <ResponsiveContainer width="100%" height={200}>
                    <PieChart>
                      <Pie
                        data={[
                          { name: "PBC", value: simRef.current?.firms?.PBC?.length || 0 },
                          { name: "PFP", value: simRef.current?.firms?.PFP?.length || 0 },
                          { name: "PMP", value: simRef.current?.firms?.PMP?.length || 0 },
                        ]}
                        dataKey="value"
                        nameKey="name"
                        outerRadius={80}
                        label
                      >
                        {[
                          "#3b82f6",
                          "#22c55e",
                          "#f59e0b",
                        ].map((c, i) => (
                          <Cell key={i} fill={c} />
                        ))}
                      </Pie>
                      <Tooltip />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <div className="p-3 bg-gray-50 rounded">
                  <div className="text-xs text-gray-600">Innovaciones</div>
                  <div className="mt-2 grid grid-cols-2 gap-2 text-sm">
                    <div className="p-2 bg-white rounded border">Programadas: <b>{innovationCounterRef.current.scheduled}</b></div>
                    <div className="p-2 bg-white rounded border">Adoptadas: <b>{innovationCounterRef.current.adopted}</b></div>
                  </div>
                  <div className="text-xs text-gray-500 mt-2">Las adopciones reducen costos y aumentan A.</div>
                </div>
              </div>

              <div className="mt-4 p-3 bg-indigo-50 border border-indigo-200 rounded">
                <div className="font-semibold mb-1">Recomendaciones en vivo</div>
                <ul className="list-disc list-inside text-xs text-indigo-900">
                  {tips.map((t, i) => (
                    <li key={i}>{t}</li>
                  ))}
                </ul>
              </div>
            </section>

            {/* final stats */}
            {finished && finalStats && (
              <section className="bg-white p-3 rounded border">
                <h3 className="font-semibold">Estadísticas finales</h3>
                <div className="text-xs text-gray-600 mt-1">Resumen completo de la sesión</div>
                <div className="grid grid-cols-4 gap-3 mt-3">
                  <KpiCard label="Ticks" value={finalStats.ticks} />
                  <KpiCard label="Avg Price" value={finalStats.avgPrice.toFixed(3)} />
                  <KpiCard label="Avg Demand" value={finalStats.avgDemand.toFixed(2)} />
                  <KpiCard label="Avg Served" value={finalStats.avgServed.toFixed(2)} />
                  <KpiCard label="Efficiency Mean" value={`${(finalStats.effMean * 100).toFixed(2)}%`} />
                  <KpiCard label="Demand Vol." value={finalStats.demandVol.toFixed(2)} />
                  <KpiCard label="Price Vol." value={finalStats.priceVol.toFixed(2)} />
                  <KpiCard label="Cumulative Regret" value={finalStats.cumulativeRegret.toFixed(2)} />
                  <KpiCard label="Welfare proxy" value={finalStats.welfareProxy.toFixed(2)} />
                  <KpiCard label="Innov. sched." value={finalStats.innovationCounts.scheduled} />
                  <KpiCard label="Innov. adopted" value={finalStats.innovationCounts.adopted} />
                  <KpiCard label="Seed" value={finalStats.seed} />
                </div>
              </section>
            )}
          </main>
        </div>

        <footer className="text-xs text-gray-500">
          Tip: el objetivo experimental es medir cuán cerca llega el planificador humano frente al óptimo oculto.
          Pulsa Finalizar para resultados y exportar.
        </footer>
      </div>
    </div>
  );
}

function KpiCard({ label, value }) {
  return (
    <div className="p-3 bg-gray-50 rounded border">
      <div className="text-xs text-gray-600">{label}</div>
      <div className="text-base font-semibold">{value}</div>
    </div>
  );
}
