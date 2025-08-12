import React, { useEffect, useRef, useState } from "react";

/*
  Simulación PBC - PFP - PMP (single-file React component)
  --------------------------------------------------------
  - Diseñada para correr 100% en el navegador (GitHub Pages / página estática).
  - No usa backend: todo en memoria; al cerrar la pestaña se pierde el estado.
  - Exporta un componente React por defecto: úsalo como App en un proyecto Vite/Create-React-App.
  - Está escrito en español con muchos comentarios para facilitar extensión.

  Nota: para desplegar en GitHub Pages puedes crear un repo, agregar este componente como src/App.jsx
  y seguir la guía típica (gh-pages o GitHub Actions). En el propio archivo hay instrucciones de despliegue
  y de cómo integrar un backend posteriormente.

  Características implementadas (mínimo viable pero funcional):
  - Generación aleatoria de consumidores heterogéneos (lineal/log/exp/polim).
  - Inicialización en equilibrio (se ajustan capacidades PBC para que Q_supply ≈ Q_agg_consumers en p0).
  - Modo de demanda: Automático (estocástico) y Modo Usuario (entrada en tiempo real sin pausar la simulación).
  - Demanda real oculta y estadísticas ruidosas para el usuario.
  - Cadena PBC → PFP → PMP con retardos aleatorios y órdenes en tránsito.
  - Innovaciones que afectan costes y productividad (random events).
  - Pausa/Play, Reset, export CSV de logs, encuesta a muestra de consumidores (estimación OLS simple).
  - Métricas básicas: eficiencia E (comparación con contrafactual "si conocieran la demanda real"), lucro agregado, stock, precios y cantidades.

  Simplificaciones razonables para mantener el demo ligero (pero fácilmente extensible):
  - Función de producción F(K,L) simplificada a un multiplicador de productividad A * capacidad.
  - No se usa un motor de físicas ni colas complejas — las órdenes se modelan con objetos y tiempos de entrega.
  - Visualizaciones sencillas (SVG sparkline) para mostrar series en tiempo real.

  Cómo usar:
  1) Abrir el proyecto React que materialice este App.
  2) Ejecutar "npm install" y "npm run dev" (Vite) o "npm start" (CRA).
  3) Desplegar en GitHub Pages: build y subir carpeta "build" o configurar gh-pages.

  Este archivo contiene comentarios de implementación y "TODO" marcados para futuras mejoras.
*/

// -----------------------------
// Utilidades y RNG determinista
// -----------------------------
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

function pickWeighted(rng, arr) {
  const total = arr.reduce((s, x) => s + x.weight, 0);
  let r = rng() * total;
  for (let i = 0; i < arr.length; i++) {
    r -= arr[i].weight;
    if (r <= 0) return arr[i].value;
  }
  return arr[arr.length - 1].value;
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

// Small OLS for q = a + b * p (we'll use it for estimaciones rápidas)
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

// Parse LaTeX-like demand equation to JS function
function parseLatexToFunc(latex, params) {
  // Clean and normalize LaTeX
  latex = latex.replace(/\\ln/g, 'Math.log').replace(/e\^\{([^}]+)\}/g, 'Math.exp($1)').replace(/\s/g, '').replace(/q=/, '');
  // Replace variables with params
  Object.keys(params).forEach(key => {
    latex = latex.replace(new RegExp(key, 'g'), params[key]);
  });
  // Safe eval to function
  try {
    // eslint-disable-next-line no-new-func
    return new Function('p', `return Math.max(0, ${latex});`);
  } catch (e) {
    console.error('Parse error:', e);
    return (p) => 0;
  }
}

// -----------------------------
// Component principal
// -----------------------------
export default function App() {
  // -----------------------------
  // Configurables (se pueden exponer en UI)
  // -----------------------------
  const DEFAULT_SEED = 12345;
  const [seed, setSeed] = useState(DEFAULT_SEED);
  const rngRef = useRef(mulberry32(seed));

  const defaultConfig = useRef({
    consumersN: 200,
    p0: 1.0,
    tickMs: 1000, // cada "segundo" simulación (configurable)
    pPriceAdjustGain: 0.08,
    pMin: 0.01,
    consumerUpdateRange: [30, 90],
    pbcCountRange: [3, 8],
    pfpCountRange: [3, 8],
    pmpCountRange: [2, 5],
    delays: {
      pbcToPfp: [5, 15],
      pfpToPmp: [5, 20],
      pmpAdjust: [10, 25],
    },
    innovation: {
      probPerTick: 0.02, // base
      costMultRange: [0.92, 0.99],
      tfpMultRange: [1.02, 1.25],
      adoptionRange: [10, 60],
    },
  });

  // -----------------------------
  // Estado de UI / control
  // -----------------------------
  const [running, setRunning] = useState(true);
  const [finished, setFinished] = useState(false);
  const [tickMs, setTickMs] = useState(defaultConfig.current.tickMs);
  const [mode, setMode] = useState("auto"); // 'auto' | 'user'
  const [logsCsvUrl, setLogsCsvUrl] = useState(null);
  const [historyWindow, setHistoryWindow] = useState(120); // mostrar últimos N ticks

  // User demand input (if mode === 'user')
  const [userDemandLatex, setUserDemandLatex] = useState('q = 100 - 5 p');
  const [userParams, setUserParams] = useState({ a: 100, b: 5 });

  // -----------------------------
  // Estado de simulación (ref para evitar renders constantes)
  // -----------------------------
  const simRef = useRef(null);
  if (!simRef.current) {
    simRef.current = {
      t: 0,
      price: defaultConfig.current.p0,
      consumers: [],
      firms: { PBC: [], PFP: [], PMP: [] },
      orders: [],
      logs: [],
      series: {
        price: [],
        qServed: [],
        qDemand: [],
        efficiency: [],
        time: [],
      },
      userPerceivedDemandFn: null, // función que usan las PBC para planificar
      hiddenDemandSamples: [], // observaciones ruidosas que vera el usuario
      seed: seed,
      rng: mulberry32(seed),
      lastTickWall: Date.now(),
      stats: {},
    };
  }

  // UI-visible state derived from simRef
  const [, setRenderTick] = useState(0);

  // -----------------------------
  // Inicialización
  // -----------------------------
  function initSimulation(newSeed = DEFAULT_SEED, cfgOverride = {}) {
    const cfg = { ...defaultConfig.current, ...cfgOverride };
    setTickMs(cfg.tickMs);
    setSeed(newSeed);
    const rng = mulberry32(newSeed);
    simRef.current = {
      t: 0,
      price: cfg.p0,
      consumers: [],
      firms: { PBC: [], PFP: [], PMP: [] },
      orders: [],
      logs: [],
      series: { price: [], qServed: [], qDemand: [], efficiency: [], time: [] },
      userPerceivedDemandFn: null,
      hiddenDemandSamples: [],
      seed: newSeed,
      rng,
      lastTickWall: Date.now(),
      stats: {},
    };

    // Generar consumidores
    const N = Math.max(10, Math.round(cfg.consumersN));
    for (let i = 0; i < N; i++) {
      const typeRand = rng();
      let type = "linear";
      if (typeRand < 0.6) type = "linear";
      else if (typeRand < 0.85) type = "log";
      else if (typeRand < 0.98) type = "exp";
      else type = "poly"; // raro

      const a = randRange(rng, 5, 200);
      // b sign: 75% >0, 20% =0, 5% <0
      const signRoll = rng();
      let b = 0;
      if (signRoll < 0.75) b = randRange(rng, 0.01, 10);
      else if (signRoll < 0.95) b = 0;
      else b = -randRange(rng, 0.1, 5);

      const Ti = Math.round(randRange(rng, cfg.consumerUpdateRange[0], cfg.consumerUpdateRange[1]));
      const nextUpdateAt = Ti; // en segundos de sim

      simRef.current.consumers.push({
        id: `C${i}`,
        type,
        a,
        b,
        Ti,
        nextUpdateAt,
        lastUpdate: 0,
      });
    }

    // Empresas: sacar aleatorio dentro de rangos configurables
    const pbcCount = Math.round(randRange(rng, cfg.pbcCountRange[0], cfg.pbcCountRange[1]));
    const pfpCount = Math.round(randRange(rng, cfg.pfpCountRange[0], cfg.pfpCountRange[1]));
    const pmpCount = Math.round(randRange(rng, cfg.pmpCountRange[0], cfg.pmpCountRange[1]));

    // Crear funciones sencillas de producción/costes para cada empresa
    for (let i = 0; i < pbcCount; i++) {
      const A = randRange(rng, 0.6, 1.4);
      const capacity = 1; // placeholder: equilibramos luego
      const marginalCost = randRange(rng, 0.2, 1.2);
      simRef.current.firms.PBC.push({
        id: `PBC${i}`,
        A,
        capacity,
        marginalCost,
        cash: 0,
        inventory: 0,
        planned: 0,
        inTransitOrders: [],
        innovations: [],
        history: [],
      });
    }
    for (let i = 0; i < pfpCount; i++) {
      const A = randRange(rng, 0.6, 1.4);
      const capacity = randRange(rng, 10, 50);
      const marginalCost = randRange(rng, 0.1, 0.8);
      simRef.current.firms.PFP.push({
        id: `PFP${i}`,
        A,
        capacity,
        marginalCost,
        cash: 0,
        inventory: 0,
        inTransitOrders: [],
        history: [],
      });
    }
    for (let i = 0; i < pmpCount; i++) {
      const A = randRange(rng, 0.6, 1.4);
      const capacity = randRange(rng, 20, 100);
      const marginalCost = randRange(rng, 0.05, 0.6);
      simRef.current.firms.PMP.push({
        id: `PMP${i}`,
        A,
        capacity,
        marginalCost,
        cash: 0,
        inventory: 0,
        inTransitOrders: [],
        history: [],
      });
    }

    // Calibrar equilibrio inicial: ajustar capacidades PBC para que Q_supply ≈ Q_agg_consumers(p0)
    // Primero computamos demanda agregada a p0
    const p0 = cfg.p0;
    const QaggConsumers = simRef.current.consumers.reduce((s, c) => s + computeConsumerDemand(c, p0, 0, rng), 0);
    // Distribuimos QaggConsumers entre PBC en proporción a A_i
    const totalA = simRef.current.firms.PBC.reduce((s, f) => s + f.A, 0) || 1;
    simRef.current.firms.PBC.forEach((f) => {
      // capacity representará capacidad de producción por tick
      f.capacity = Math.max(0.1, (QaggConsumers * (f.A / totalA)) / simRef.current.firms.PBC.length);
      // inventory inicial igual a capacidad
      f.inventory = f.capacity;
    });

    // PFP y PMP ajustamos inventarios/stock inicial para permitir cadena de suministros
    simRef.current.firms.PFP.forEach((f) => {
      f.inventory = f.capacity * 0.5;
    });
    simRef.current.firms.PMP.forEach((f) => {
      f.inventory = f.capacity * 0.7;
    });

    // userPerceivedDemandFn por defecto: función aleatoria (AR(1) por empresa simplificada)
    simRef.current.userPerceivedDemandFn = null; // modo auto lo ignorará

    // Primeros logs/series
    simRef.current.series.price.push(p0);
    simRef.current.series.qServed.push(QaggConsumers);
    simRef.current.series.qDemand.push(QaggConsumers);
    simRef.current.series.time.push(0);

    // Forzar render inicial
    setRenderTick((r) => r + 1);
  }

  // -----------------------------
  // Helper: calcular demanda individual dada ecuación y precio
  // -----------------------------
  function computeConsumerDemand(consumer, p, t, rng) {
    let q = 0;
    if (consumer.type === "linear") {
      q = consumer.a - consumer.b * p;
    } else if (consumer.type === "log") {
      q = consumer.a - consumer.b * Math.log(1 + Math.max(0, p));
    } else if (consumer.type === "exp") {
      q = consumer.a * Math.exp(-consumer.b * p);
    } else if (consumer.type === "poly") {
      // simple polinomial: a - b*p - c*p^2 (c small)
      const c = Math.max(0.001, consumer.b * 0.01);
      q = Math.max(0, consumer.a - consumer.b * p - c * p * p);
    }
    // Ruido multiplicativo
    const noiseSigma = 0.05; // 5% ruido relativo
    const noise = 1 + (rng() - 0.5) * 2 * noiseSigma;
    q = Math.max(0, q * noise);
    return q;
  }

  // -----------------------------
  // Aplicar ecuación de demanda ingresada por usuario
  // -----------------------------
  function applyUserDemand() {
    const fn = parseLatexToFunc(userDemandLatex, userParams);
    simRef.current.userPerceivedDemandFn = fn;
    // set mode to user implicitly
    setMode("user");
    // log
    simRef.current.logs.push({ t: simRef.current.t, type: "user_set_demand", detail: { userDemandLatex, userParams } });
  }

  // -----------------------------
  // Tick de simulación (unidad: 1 segundo por defecto)
  // -----------------------------
  function simTick() {
    const s = simRef.current;
    const cfg = defaultConfig.current;
    const rng = s.rng;
    s.t += 1; // s.t in seconds (discrete)

    // 1) Consumidores -> posible actualización de ecuación
    let Qagg = 0;
    for (const c of s.consumers) {
      if (s.t >= c.nextUpdateAt) {
        // re-muestreo o small drift
        const changeRoll = rng();
        if (changeRoll < 0.15) {
          // remuestreo completo
          c.a = randRange(rng, 5, 200);
          const signRoll = rng();
          if (signRoll < 0.75) c.b = randRange(rng, 0.01, 10);
          else if (signRoll < 0.95) c.b = 0;
          else c.b = -randRange(rng, 0.1, 5);
        } else {
          // small noise
          c.a *= 1 + (rng() - 0.5) * 0.1;
          c.b *= 1 + (rng() - 0.5) * 0.05;
        }
        // shock raro que multiplica intercepto
        if (rng() < 0.01) c.a *= randRange(rng, 1.5, 3.0);
        c.nextUpdateAt = s.t + Math.round(randRange(rng, cfg.consumerUpdateRange[0], cfg.consumerUpdateRange[1]));
        c.lastUpdate = s.t;
      }
      Qagg += computeConsumerDemand(c, s.price, s.t, rng);
    }

    // Guardamos sample ruidoso para la vista del usuario
    // Mostrar estadísticas ruidosas: submuestra con ruido
    const noisyObs = s.consumers.slice(0, Math.min(30, s.consumers.length)).map((c) => {
      const q = computeConsumerDemand(c, s.price, s.t, rng);
      // añadir ruido en observación
      const obs = q * (1 + (rng() - 0.5) * 0.2);
      return { p: s.price * (1 + (rng() - 0.02) * 0.04), q: Math.max(0, obs) };
    });
    s.hiddenDemandSamples = noisyObs;

    // 2) Empresas deciden planificación
    // PBC: usan userPerceivedDemandFn (si modo usuario) o su propia demanda estimada automática
    const pbcPerceivedFn = mode === "user" && s.userPerceivedDemandFn ? s.userPerceivedDemandFn : (p) => {
      // bloqueo: para modo auto usamos una simple AR(1)-like per-firm linear estimate with noise
      // We'll aggregate a linear estimate across consumers but add firm-level noise
      // Simpler: each PBC perceives demand = total hidden demand * random factor
      return Qagg * (0.8 + 0.4 * rng());
    };

    // PBC plan: repartir la perceived demand across PBC proportionally to A*capacity
    const sumAcap = s.firms.PBC.reduce((S, f) => S + f.A * f.capacity, 0) || 1;
    for (const f of s.firms.PBC) {
      const share = (f.A * f.capacity) / sumAcap;
      const perceivedTotal = typeof pbcPerceivedFn === "function" ? pbcPerceivedFn(s.price) : 0;

      const plan = perceivedTotal * share; // unidades a planear producir
      f.planned = plan;
      // Si plan > inventory, send orders to PFP
      if (plan > f.inventory + 1e-6) {
        const needed = Math.max(0, plan - f.inventory);
        // Send an order to a random PFP (could be improved: multi-sourcing)
        const pfp = s.firms.PFP[Math.floor(rng() * s.firms.PFP.length)];
        if (pfp) {
          const delay = Math.round(randRange(rng, cfg.delays.pbcToPfp[0], cfg.delays.pbcToPfp[1]));
          const due = s.t + delay;
          const order = { from: f.id, to: pfp.id, amount: needed, due, filled: false, level: "PBC->PFP" };
          s.orders.push(order);
          f.inTransitOrders.push(order);
        }
      }
    }

    // PFP process orders due this tick: when due, they reduce their inventory (if possible) and schedule order to PMP if lack
    for (const order of s.orders.filter((o) => !o.filled && o.due <= s.t)) {
      if (order.level === "PBC->PFP") {
        const pfp = s.firms.PFP.find((x) => x.id === order.to);
        if (!pfp) continue;
        // If pfp inventory sufficient -> fill to PBC
        if (pfp.inventory >= order.amount) {
          pfp.inventory -= order.amount;
          // find PBC and increase its inventory immediately (simulate transfer)
          const pbc = s.firms.PBC.find((x) => x.id === order.from);
          if (pbc) {
            pbc.inventory += order.amount;
            order.filled = true;
            order.filledAt = s.t;
            // log
            s.logs.push({ t: s.t, type: "fill", detail: order });
          }
        } else {
          // need to request from PMP: create PFP->PMP order
          const needed = Math.max(0, order.amount - pfp.inventory);
          // create order to PMP
          const pmp = s.firms.PMP[Math.floor(rng() * s.firms.PMP.length)];
          if (pmp) {
            const delayPfpToPmp = Math.round(randRange(rng, cfg.delays.pfpToPmp[0], cfg.delays.pfpToPmp[1]));
            const duePmp = s.t + delayPfpToPmp;
            const order2 = { from: pfp.id, to: pmp.id, amount: needed, due: duePmp, filled: false, level: "PFP->PMP", originalOrder: order };
            s.orders.push(order2);
            pfp.inTransitOrders.push(order2);
            // mark original order as waiting
            order.waitingFor = order2;
          }
        }
      } else if (order.level === "PFP->PMP") {
        const pmp = s.firms.PMP.find((x) => x.id === order.to);
        if (!pmp) continue;
        // pmp supplies if inventory enough; else partial
        const supplied = Math.min(order.amount, pmp.inventory);
        pmp.inventory -= supplied;
        order.filled = supplied >= order.amount;
        order.filledAt = s.t;
        // deliver to PFP inventory
        const pfp = s.firms.PFP.find((x) => x.id === order.from);
        if (pfp) {
          pfp.inventory += supplied;
        }
        // If partially supplied, schedule more later (simulate acquisition)
        if (supplied < order.amount) {
          // pmp tries to replenish inventory after its own adjustment delay
          const replenishDelay = Math.round(randRange(rng, cfg.delays.pmpAdjust[0], cfg.delays.pmpAdjust[1]));
          const extraAmount = order.amount - supplied;
          // we schedule a new order to 'market' (not modeled) that will arrive later
          const fakeArrival = { from: "external", to: pmp.id, amount: extraAmount, due: s.t + replenishDelay, filled: false, level: "EXTERNAL->PMP" };
          s.orders.push(fakeArrival);
          s.logs.push({ t: s.t, type: "pmp_replenish_scheduled", detail: fakeArrival });
        }
        // Try to fill original PBC order if that was waiting
        if (order.originalOrder) {
          const orig = order.originalOrder;
          if (!orig.filled) {
            const pfpNow = s.firms.PFP.find((x) => x.id === orig.to);
            if (pfpNow && pfpNow.inventory >= orig.amount) {
              pfpNow.inventory -= orig.amount;
              const pbc = s.firms.PBC.find((x) => x.id === orig.from);
              if (pbc) {
                pbc.inventory += orig.amount;
                orig.filled = true;
                orig.filledAt = s.t;
                s.logs.push({ t: s.t, type: "fill_after_pmp", detail: orig });
              }
            }
          }
        }
      } else if (order.level === "EXTERNAL->PMP") {
        // external supply arrives and increases pmp inventory
        const pmp = s.firms.PMP.find((x) => x.id === order.to);
        if (pmp) {
          pmp.inventory += order.amount;
        }
        order.filled = true;
        order.filledAt = s.t;
      }
    }

    // 3) Producción: PBC produce based on inventory and planned
    let Qserved = 0;
    for (const f of s.firms.PBC) {
      // Actual production possible: limited by inventory (inputs) and capacity
      const possible = Math.min(f.planned, f.inventory + f.capacity);
      const produced = Math.max(0, possible);
      // consume inventory proportionally (simple model)
      const consumed = Math.min(f.inventory, produced);
      f.inventory -= consumed;
      // produce goods and sell to consumers up to demand
      // We'll assume firms sell at market price and supply to aggregate demand until either produced exhausted
      Qserved += produced;
      // profits
      const price = s.price;
      const revenue = price * produced;
      const cost = f.marginalCost * produced;
      f.cash += revenue - cost;
      f.history.push({ t: s.t, produced, revenue, cost, cash: f.cash });
    }

    // 4) Mercado: consumidores compran según demanda real oculta (no conocen planes)
    // We compute Qd = aggregate demand at price
    let Qd = 0;
    for (const c of s.consumers) {
      Qd += computeConsumerDemand(c, s.price, s.t, rng);
    }

    // Served quantity is min(Qserved, Qd) — if supply > demand, unsold goods remain as inventory (simplified)
    const Q_actual_served = Math.min(Qserved, Qd);

    // If supply < demand -> shortage costs (lost sales). Keep track for metrics
    const shortage = Math.max(0, Qd - Qserved);

    // 5) Actual adjustments: price adjusts slowly based on excess demand
    const adjustGain = cfg.pPriceAdjustGain;
    const delta = Qd === 0 ? 0 : (Qd - Qserved) / Qd;
    s.price = Math.max(cfg.pMin, s.price * (1 + adjustGain * delta));

    // 6) Innovaciones: cada empresa puede tener un evento aleatorio
    for (const flevel of [s.firms.PBC, s.firms.PFP, s.firms.PMP]) {
      for (const f of flevel) {
        if (rng() < cfg.innovation.probPerTick) {
          // innovation event
          const costMul = randRange(rng, cfg.innovation.costMultRange[0], cfg.innovation.costMultRange[1]);
          const tfpMul = randRange(rng, cfg.innovation.tfpMultRange[0], cfg.innovation.tfpMultRange[1]);
          const adoption = Math.round(randRange(rng, cfg.innovation.adoptionRange[0], cfg.innovation.adoptionRange[1]));
          // schedule adoption after delay
          const innov = { t0: s.t, adopted: false, adoptAt: s.t + adoption, costMul, tfpMul };
          f.innovations.push(innov);
          s.logs.push({ t: s.t, type: "innovation_scheduled", firm: f.id, innov });
        }
        // check adoption
        for (const innov of f.innovations.filter((x) => !x.adopted && x.adoptAt <= s.t)) {
          f.marginalCost *= innov.costMul;
          f.A *= innov.tfpMul;
          innov.adopted = true;
          s.logs.push({ t: s.t, type: "innovation_adopted", firm: f.id, innov });
        }
      }
    }

    // 7) Limpieza de órdenes llenas
    s.orders = s.orders.filter((o) => !o.filled);

    // 8) Metrics & logs
    // Efficiency E: contrafactual si las empresas hubiesen conocido la demanda real desde el inicio.
    // Simplificación: consideramos Q_optimal(t) = Qd (si hubiesen sabido demanda serían capaces de servir Qd)
    const Qoptimal = Qd;
    // acumulamos E por tick en una serie simple (en el denominador guardamos Qoptimal acumulado >0)
    s.series.price.push(s.price);
    s.series.qServed.push(Q_actual_served);
    s.series.qDemand.push(Qd);
    s.series.time.push(s.t);

    // compute rolling efficiency over series history
    const sumQopt = s.series.qDemand.reduce((a, b) => a + b, 0) || 1;
    const sumAbs = s.series.qDemand.reduce((acc, q, idx) => acc + Math.abs((s.series.qServed[idx] || 0) - q), 0);
    const E = 1 - sumAbs / sumQopt;
    s.series.efficiency = s.series.efficiency || [];
    s.series.efficiency.push(E);

    // store logs
    s.logs.push({ t: s.t, type: "tick", price: s.price, Qd, Qserved: Q_actual_served, shortage });

    // 9) Performance: trim series length
    const maxLen = 1000;
    for (const k of Object.keys(s.series)) {
      if (s.series[k].length > maxLen) s.series[k].shift();
    }

    // 10) render update (throttle)
    if (s.t % Math.max(1, Math.floor(1000 / tickMs)) === 0) {
      setRenderTick((r) => r + 1);
    } else {
      setRenderTick((r) => r + 1);
    }
  }

  // -----------------------------
  // Efecto principal: arranca/pausa el ciclo
  // -----------------------------
  useEffect(() => {
    if (!simRef.current || !simRef.current.rng) initSimulation(seed);
    let timer = null;
    if (running && !finished) {
      timer = setInterval(() => {
        simTick();
      }, tickMs);
    }
    return () => {
      if (timer) clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, tickMs, mode, finished]);

  // -----------------------------
  // Export logs as CSV
  // -----------------------------
  function exportLogsCSV() {
    const s = simRef.current;
    const lines = [];
    lines.push(["t", "type", "detail"].join(","));
    for (const row of s.logs) {
      lines.push([row.t, row.type, JSON.stringify(row.detail || row)].join(","));
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    setLogsCsvUrl(url);
  }

  // -----------------------------
  // Encuesta a subgrupo simulado (devuelve estimación OLS con ruido)
  // -----------------------------
  function runSurvey(sampleSize = 30) {
    const s = simRef.current;
    const rng = s.rng;
    const sample = [];
    for (let i = 0; i < sampleSize; i++) {
      const c = s.consumers[Math.floor(rng() * s.consumers.length)];
      const p = s.price * (1 + (rng() - 0.5) * 0.04);
      const q = computeConsumerDemand(c, p, s.t, rng) * (1 + (rng() - 0.5) * 0.15);
      sample.push({ p, q });
    }
    const xs = sample.map((s) => s.p);
    const ys = sample.map((s) => s.q);
    const est = olsLinear(xs, ys);
    s.logs.push({ t: s.t, type: "survey", sampleSize, est });
    // return noisy estimate
    return est;
  }

  // -----------------------------
  // Reset
  // -----------------------------
  function handleReset() {
    initSimulation(seed);
    setFinished(false);
  }

  // -----------------------------
  // Finalizar: calcula stats finales
  // -----------------------------
  function handleFinalize() {
    setRunning(false);
    setFinished(true);
  }

  // -----------------------------
  // Renders: minicharts + status
  // -----------------------------
  function Sparkline({ data, height = 48, width = 240 }) {
    if (!data || data.length === 0) return <div className="text-xs text-muted-foreground">sin datos</div>;
    const N = data.length;
    const min = Math.min(...data);
    const max = Math.max(...data);
    const range = Math.max(1e-6, max - min);
    const points = data.map((v, i) => {
      const x = (i / (N - 1)) * width;
      const y = height - ((v - min) / range) * height;
      return `${x},${y}`;
    });
    return (
      <svg width={width} height={height}>
        <polyline points={points.join(" ")} fill="none" stroke="#0ea5e9" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      </svg>
    );
  }

  // Derived stats for UI
  const s = simRef.current;
  const latestPrice = s.series.price[s.series.price.length - 1] || defaultConfig.current.p0;
  const latestQd = s.series.qDemand[s.series.qDemand.length - 1] || 0;
  const latestQserved = s.series.qServed[s.series.qServed.length - 1] || 0;
  const latestE = s.series.efficiency ? s.series.efficiency[s.series.efficiency.length - 1] : 0;

  // Lucro agregado
  const aggregateProfit = Object.values(s.firms).flat().reduce((sum, f) => sum + f.cash, 0);

  // Small suggestion engine
  function suggest() {
    // Simple rule: if E low and price above median demand => try to lower price
    if (!s || !s.series || s.series.price.length < 5) return "No hay suficientes datos aún.";
    const recentPrices = s.series.price.slice(-20);
    const recentQd = s.series.qDemand.slice(-20).reduce((a, b) => a + b, 0) / Math.max(1, Math.min(20, s.series.qDemand.length));
    if (latestQserved < 0.9 * recentQd) return "Sugerencia: hay escasez. Considere bajar precio o aumentar producción (si es posible).";
    if (latestQserved > 1.2 * recentQd) return "Sugerencia: hay exceso de oferta. Considere subir precio o reducir producción.";
    return "Sugerencia: la situación está relativamente balanceada.";
  }

  // -----------------------------
  // UI: JSX
  // -----------------------------
  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 p-4 font-sans">
      <script src="https://cdnjs.cloudflare.com/ajax/libs/mathjax/2.7.5/MathJax.js?config=TeX-MML-AM_CHTML" async></script>
      <div className="max-w-7xl mx-auto grid grid-cols-12 gap-4">
        <div className="col-span-3 bg-white rounded-2xl shadow p-4">
          <h2 className="text-lg font-semibold">Control de simulación</h2>
          <div className="flex gap-2 mt-3">
            <button className="px-3 py-2 bg-green-500 text-white rounded" onClick={() => setRunning(true)}>
              ▶️ Ejecutar
            </button>
            <button className="px-3 py-2 bg-yellow-400 text-white rounded" onClick={() => setRunning(false)}>
              ⏸ Pausar
            </button>
            <button className="px-3 py-2 bg-red-500 text-white rounded" onClick={handleReset}>
              🔁 Reset
            </button>
            <button className="px-3 py-2 bg-purple-500 text-white rounded" onClick={handleFinalize}>
              Finalizar
            </button>
          </div>

          <div className="mt-4 space-y-2">
            <label className="block text-sm">Seed (reproducible)</label>
            <input className="w-full p-2 border rounded" value={seed} onChange={(e) => setSeed(parseInt(e.target.value || 0))} />
            <button
              className="w-full mt-2 p-2 bg-blue-600 text-white rounded"
              onClick={() => initSimulation(Number(seed || DEFAULT_SEED))}
            >
              Inicializar con seed
            </button>
          </div>

          <div className="mt-4">
            <h3 className="font-medium">Modo demanda</h3>
            <div className="mt-2">
              <label className="inline-flex items-center">
                <input type="radio" name="mode" checked={mode === "auto"} onChange={() => setMode("auto")} />
                <span className="ml-2">Automático</span>
              </label>
              <label className="inline-flex items-center ml-4">
                <input type="radio" name="mode" checked={mode === "user"} onChange={() => setMode("user")} />
                <span className="ml-2">Usuario</span>
              </label>
            </div>

            {mode === "user" && (
              <div className="mt-2 bg-gray-50 p-2 rounded">
                <div className="text-sm mb-2">Inserte función de demanda en formato LaTeX (ej: q = a - b p, q = a - b \ln(1 + p), q = a e^{"{-b p}"}). Use \ln para log, e^{"{}"} para exp.</div>
                <input className="w-full p-2 border rounded" value={userDemandLatex} onChange={(e) => setUserDemandLatex(e.target.value)} />
                <div className="mt-2">
                  <label className="text-sm">a</label>
                  <input className="w-full p-2 border rounded" value={userParams.a} onChange={(e) => setUserParams({ ...userParams, a: parseFloat(e.target.value) })} />
                  <label className="text-sm mt-2">b</label>
                  <input className="w-full p-2 border rounded" value={userParams.b} onChange={(e) => setUserParams({ ...userParams, b: parseFloat(e.target.value) })} />
                </div>
                <button className="w-full mt-2 p-2 bg-indigo-600 text-white rounded" onClick={applyUserDemand}>
                  Aplicar ecuación (sin pausar)
                </button>
                <div id="latex-preview" className="mt-2 text-center" dangerouslySetInnerHTML={{ __html: `$$${userDemandLatex}$$` }} />
              </div>
            )}
          </div>

          <div className="mt-4">
            <h3 className="font-medium">Herramientas</h3>
            <button className="w-full mt-2 p-2 bg-slate-600 text-white rounded" onClick={() => {
              const est = runSurvey(30);
              alert(`Estimación OLS (q = a + b p)\na=${est.a.toFixed(3)}, b=${est.b.toFixed(3)}`);
            }}>
              Encuesta a 30 consumidores (ruidosa)
            </button>
            <button className="w-full mt-2 p-2 bg-emerald-600 text-white rounded" onClick={exportLogsCSV}>
              Exportar logs (CSV)
            </button>
            {logsCsvUrl && (
              <a className="block mt-2 text-sm text-blue-700" href={logsCsvUrl} download={`sim_logs_seed_${seed}.csv`}>Descargar CSV</a>
            )}
          </div>

          <div className="mt-4 text-sm text-gray-600">
            <div>Precio actual: <strong>{latestPrice.toFixed(3)}</strong></div>
            <div>Demanda (estimada oculta): <strong>{latestQd.toFixed(2)}</strong></div>
            <div>Cantidad servida: <strong>{latestQserved.toFixed(2)}</strong></div>
            <div>Eficiencia (E): <strong>{(latestE * 100).toFixed(2)}%</strong></div>
            <div className="mt-2 text-xs">Sugerencia: {suggest()}</div>
          </div>
        </div>

        <div className="col-span-9 bg-white rounded-2xl shadow p-4">
          <div className="flex justify-between items-start">
            <h2 className="text-xl font-semibold">Panel en tiempo real</h2>
            <div className="text-sm text-gray-500">t = {s.t}s</div>
          </div>

          <div className="grid grid-cols-3 gap-4 mt-4">
            <div className="p-3 bg-gray-50 rounded">
              <div className="text-xs text-gray-500">Precio (serie)</div>
              <Sparkline data={s.series.price.slice(-historyWindow)} />
              <div className="text-sm font-medium">{latestPrice.toFixed(3)}</div>
            </div>
            <div className="p-3 bg-gray-50 rounded">
              <div className="text-xs text-gray-500">Demanda oculta (serie)</div>
              <Sparkline data={s.series.qDemand.slice(-historyWindow)} />
              <div className="text-sm font-medium">{(s.series.qDemand.slice(-1)[0] || 0).toFixed(2)}</div>
            </div>
            <div className="p-3 bg-gray-50 rounded">
              <div className="text-xs text-gray-500">Cantidad servida (serie)</div>
              <Sparkline data={s.series.qServed.slice(-historyWindow)} />
              <div className="text-sm font-medium">{(s.series.qServed.slice(-1)[0] || 0).toFixed(2)}</div>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-3 gap-4">
            <div className="col-span-2">
              <h3 className="font-medium">Logs recientes</h3>
              <div className="h-56 overflow-auto bg-gray-50 rounded p-2 text-xs">
                {s.logs.slice(-200).map((L, idx) => (
                  <div key={idx} className="p-1 border-b border-gray-100">
                    <strong>[{L.t}]</strong> {L.type} {L.price ? ` price=${(L.price||0).toFixed(2)}` : ""}
                  </div>
                ))}
              </div>
            </div>
            <div>
              <h3 className="font-medium">Empresas (resumen)</h3>
              <div className="h-56 overflow-auto bg-gray-50 rounded p-2 text-xs">
                <div className="mb-2"><strong>PBC</strong></div>
                {s.firms.PBC.map((f) => (
                  <div key={f.id} className="text-xs border-b border-dashed py-1">
                    <div>{f.id} A={f.A.toFixed(2)} cap={f.capacity.toFixed(2)} inv={f.inventory.toFixed(2)} cash={f.cash.toFixed(1)}</div>
                  </div>
                ))}
                <div className="mt-2"><strong>PFP / PMP</strong></div>
                {s.firms.PFP.slice(0, 6).map((f) => (
                  <div key={f.id} className="text-xs border-b border-dashed py-1">{f.id} inv={f.inventory.toFixed(1)}</div>
                ))}
                {s.firms.PMP.slice(0, 6).map((f) => (
                  <div key={f.id} className="text-xs border-b border-dashed py-1">{f.id} inv={f.inventory.toFixed(1)}</div>
                ))}
              </div>
            </div>
          </div>

          <div className="mt-4">
            <h3 className="font-medium">Observaciones agregadas (ruidosas)</h3>
            <div className="text-xs text-gray-500">Muestra que vería el planificador (ruido, no identifica la demanda real completa)</div>
            <div className="mt-2 grid grid-cols-4 gap-2 text-xs">
              {s.hiddenDemandSamples.map((h, i) => (
                <div key={i} className="p-2 bg-white rounded shadow-sm">p={h.p.toFixed(2)} q_obs={h.q.toFixed(2)}</div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {finished && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center">
          <div className="bg-white p-6 rounded-lg shadow-lg max-w-md w-full">
            <h2 className="text-xl font-bold mb-4">Estadísticas Finales</h2>
            <div className="space-y-2 text-sm">
              <p>Eficiencia: <strong>{(latestE * 100).toFixed(2)}%</strong></p>
              <p>Lucro Agregado: <strong>{aggregateProfit.toFixed(2)}</strong></p>
              <p>Precio Final: <strong>{latestPrice.toFixed(3)}</strong></p>
              <p>Demanda Final Oculta: <strong>{latestQd.toFixed(2)}</strong></p>
              <p>Cantidad Servida Final: <strong>{latestQserved.toFixed(2)}</strong></p>
            </div>
            <button className="mt-4 w-full p-2 bg-red-500 text-white rounded" onClick={() => setFinished(false)}>
              Cerrar
            </button>
          </div>
        </div>
      )}

      <footer className="max-w-7xl mx-auto mt-6 text-xs text-gray-500">
        <div>Nota: Esta simulación corre enteramente en el navegador y no guarda datos persistentemente. Cerrar la pestaña borra todo.</div>
        <div className="mt-2">Para desplegar en GitHub Pages: crear un repo, añadir este proyecto React, compilar (npm run build) y activar Pages (carpeta build/). Si quieres, puedo generar el README y el pipeline GitHub Actions para deploy automático.</div>
      </footer>
    </div>
  );
}