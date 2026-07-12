// FX adapter over open.er-api.com (same source the frontend CurrencySwitch uses).
// Latest-only: exact when we capture at archive time; backfill stamps today's rate (approx).
const FX_URL = 'https://open.er-api.com/v6/latest/USD';
const MEM_TTL = 12 * 60 * 60 * 1000; // mirror the frontend's 12h cache

module.exports = function makeFxRates({ pgPool, httpGet }) {
  const get = httpGet || require('axios').get;
  let mem = null; // { ts, rates }

  async function ensureTable() {
    if (!pgPool) return;
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS fx_rates (
        currency TEXT NOT NULL,
        date     DATE NOT NULL,
        usd_rate NUMERIC NOT NULL,
        PRIMARY KEY (currency, date)
      )`);
  }

  async function fetchTable() {
    if (mem && Date.now() - mem.ts < MEM_TTL) return mem.rates;
    const res = await get(FX_URL);
    const d = res && res.data;
    if (!d || d.result !== 'success' || !d.rates) throw new Error('fx: bad response');
    mem = { ts: Date.now(), rates: d.rates };
    return d.rates;
  }

  async function getUsdRate(currency, date) {
    const cur = String(currency || 'USD').toUpperCase();
    if (cur === 'USD') return 1;
    if (pgPool) {
      const r = await pgPool.query('SELECT usd_rate FROM fx_rates WHERE currency=$1 AND date=$2', [cur, date]);
      if (r.rows[0]) return Number(r.rows[0].usd_rate);
    }
    try {
      const rates = await fetchTable();
      const per = Number(rates[cur]);
      if (!isFinite(per) || per <= 0) return null;
      const usdRate = 1 / per;
      if (pgPool) {
        await pgPool.query(
          `INSERT INTO fx_rates (currency, date, usd_rate) VALUES ($1,$2,$3)
           ON CONFLICT (currency, date) DO NOTHING`, [cur, date, usdRate]);
      }
      return usdRate;
    } catch (e) {
      console.error('[fx] rate lookup failed:', e.message);
      return null;
    }
  }

  return { ensureTable, getUsdRate };
};
