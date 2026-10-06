#!/usr/bin/env bun
/**
 * trapcheck: read-only safety screen for trending Solana tokens.
 * No wallet, no trading. Needs HELIUS_API_KEY (free tier is enough).
 *   bun trapcheck.ts --top 10 [--json] | --mints <mint,mint>
 * A SAFETY SCREEN, NOT A BUY SIGNAL. See README.md.
 */
import { getTrending, getPools, bestPool } from './dex';

const args = process.argv.slice(2);
const argv = (k: string, d?: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const TOP = Math.max(1, Number(argv('--top', '10')) || 10);
const JSON_OUT = args.includes('--json');
const MINTS = argv('--mints')?.split(',').map(s => s.trim()).filter(Boolean);
const HELIUS = process.env.HELIUS_API_KEY;
if (!HELIUS) { console.error('HELIUS_API_KEY missing in env (put it in a .env file next to trapcheck.ts, or export it).'); process.exit(2); }
const RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS}`;
const UA = { 'User-Agent': 'trapcheck (read-only)' };

async function rpc(method: string, params: any[]): Promise<any> {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j: any = await r.json(); if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error).slice(0, 120)}`); return j.result;
}
async function mintAuthorities(mint: string): Promise<{ mintAuthority: string | null; freezeAuthority: string | null; decimals: number | null; program: string | null }> {
  try {
    const r = await rpc('getAccountInfo', [mint, { encoding: 'jsonParsed' }]);
    const info = r?.value?.data?.parsed?.info; const program = r?.value?.owner ?? null;
    return { mintAuthority: info?.mintAuthority ?? null, freezeAuthority: info?.freezeAuthority ?? null, decimals: info?.decimals ?? null, program };
  } catch { return { mintAuthority: null, freezeAuthority: null, decimals: null, program: null }; }
}
async function holderStats(mint: string): Promise<{ top10ShareExPool: number | null; largestShare: number | null; holdersSampled: number }> {
  try {
    const [largest, supply] = await Promise.all([rpc('getTokenLargestAccounts', [mint, { commitment: 'confirmed' }]), rpc('getTokenSupply', [mint])]);
    const bals: bigint[] = (largest?.value ?? []).map((a: any) => BigInt(a.amount)).sort((a: bigint, b: bigint) => (a > b ? -1 : a < b ? 1 : 0));
    const total = BigInt(supply?.value?.amount ?? '0'); if (total === 0n || !bals.length) return { top10ShareExPool: null, largestShare: null, holdersSampled: bals.length };
    // The largest account is usually the pool; measure concentration among the next ten vs circulating ex-pool.
    const pool = bals[0]; const circ = total - pool; const next10 = bals.slice(1, 11).reduce((s, b) => s + b, 0n);
    return { top10ShareExPool: circ > 0n ? Number(next10 * 10000n / circ) / 10000 : null, largestShare: Number(pool * 10000n / total) / 10000, holdersSampled: bals.length };
  } catch { return { top10ShareExPool: null, largestShare: null, holdersSampled: 0 }; }
}
async function rugcheck(mint: string): Promise<{ score: number | null; lpLockedPct: number | null; risks: { name: string; level: string }[]; deployerFlag: string | null; ok: boolean }> {
  try {
    const r = await fetch(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`, { headers: UA });
    if (!r.ok) { const s = await fetch(`https://api.rugcheck.xyz/v1/tokens/${mint}/report/summary`, { headers: UA }); if (!s.ok) return { score: null, lpLockedPct: null, risks: [], deployerFlag: null, ok: false }; const j: any = await s.json(); return { score: j.score ?? null, lpLockedPct: null, risks: (j.risks ?? []).map((x: any) => ({ name: x.name, level: x.level })), deployerFlag: null, ok: true }; }
    const j: any = await r.json();
    const lp = (j.markets ?? []).map((m: any) => m?.lp?.lpLockedPct).filter((x: any) => typeof x === 'number');
    const risks = (j.risks ?? []).map((x: any) => ({ name: x.name, level: x.level }));
    const deployerFlag = j.creator && (j.creatorTokens?.some?.((t: any) => t.rugged) ? 'prior rug' : null);
    return { score: j.score ?? j.score_normalised ?? null, lpLockedPct: lp.length ? Math.max(...lp) : null, risks, deployerFlag: deployerFlag ?? (risks.some((x: any) => /creator|deployer|rug/i.test(x.name)) ? 'flagged' : null), ok: true };
  } catch { return { score: null, lpLockedPct: null, risks: [], deployerFlag: null, ok: false }; }
}

type Row = {
  trendingRank: number; source: string; symbol: string; name: string; mint: string; pairUrl: string | null; dex: string | null;
  ageMinutes: number | null; liquidityUsd: number; volumeH1: number; buyRatioH1: number | null; priceUsd: number;
  top10Share: number | null; poolShare: number | null; lpLockedPct: number | null; mintAuthority: string | null; freezeAuthority: string | null;
  deployerRugs: string | null; rugcheckScore: number | null; rugcheckRisks: { name: string; level: string }[];
  verdict: 'TRAP' | 'CAUTION' | 'NEUTRAL' | 'UNKNOWN'; reasons: string[];
};

function judge(r: Omit<Row, 'verdict' | 'reasons'>): { verdict: Row['verdict']; reasons: string[] } {
  const trap: string[] = [], caution: string[] = [];
  if (r.liquidityUsd < 10_000) trap.push(`liquidity $${r.liquidityUsd.toFixed(0)} < $10K (pools this thin are easy to drain)`);
  if (r.mintAuthority) trap.push('mint authority still live (supply can be inflated)');
  if (r.freezeAuthority) trap.push('freeze authority still live (your tokens can be frozen)');
  if (r.lpLockedPct != null && r.lpLockedPct < 50 && r.liquidityUsd < 100_000) trap.push(`LP only ${r.lpLockedPct.toFixed(0)}% locked/burned on a $${(r.liquidityUsd / 1000).toFixed(0)}K pool`);
  if (r.top10Share != null && r.top10Share > 0.5) trap.push(`top-10 holders own ${(r.top10Share * 100).toFixed(0)}% of circulating`);
  if (r.rugcheckRisks.some(x => /danger/i.test(x.level))) trap.push(`RugCheck danger: ${r.rugcheckRisks.filter(x => /danger/i.test(x.level)).map(x => x.name).join(', ')}`);
  if (r.deployerRugs) trap.push(`deployer ${r.deployerRugs}`);
  if (r.ageMinutes != null && r.ageMinutes < 30) caution.push(`pair is ${r.ageMinutes} min old`);
  if (r.top10Share != null && r.top10Share > 0.3 && r.top10Share <= 0.5) caution.push(`top-10 holders own ${(r.top10Share * 100).toFixed(0)}% of circulating`);
  if (r.lpLockedPct != null && r.lpLockedPct >= 50 && r.lpLockedPct < 80) caution.push(`LP ${r.lpLockedPct.toFixed(0)}% locked`);
  if (r.buyRatioH1 != null && r.buyRatioH1 < 0.3) caution.push(`only ${(r.buyRatioH1 * 100).toFixed(0)}% of last-hour trades were buys (dumping)`);
  if (r.rugcheckRisks.some(x => /warn/i.test(x.level))) caution.push(`RugCheck warn: ${r.rugcheckRisks.filter(x => /warn/i.test(x.level)).map(x => x.name).slice(0, 3).join(', ')}`);
  const unknown = r.top10Share == null && r.mintAuthority == null && r.freezeAuthority == null && r.lpLockedPct == null && r.liquidityUsd === 0;
  if (unknown) return { verdict: 'UNKNOWN', reasons: ['no on-chain or pool data returned'] };
  if (trap.length) return { verdict: 'TRAP', reasons: [...trap, ...caution] };
  if (caution.length) return { verdict: 'CAUTION', reasons: caution };
  return { verdict: 'NEUTRAL', reasons: ['no traps found by these checks. This only checks for traps. It is NOT a buy signal'] };
}

async function main() {
  const t0 = Date.now();
  let list: { address: string; source: string }[];
  if (MINTS?.length) list = MINTS.map(m => ({ address: m, source: 'manual' }));
  else { const tr = await getTrending(); list = tr.map(t => ({ address: t.address, source: t.source })); }
  list = list.slice(0, TOP);
  const rows: Row[] = [];
  for (let i = 0; i < list.length; i++) {
    const { address: mint, source } = list[i];
    const pools = await getPools(mint).catch(() => []);
    const best = bestPool(pools);
    const [auth, hs, rc] = await Promise.all([mintAuthorities(mint), holderStats(mint), rugcheck(mint)]);
    const h1b = best?.txns?.h1?.buys ?? 0, h1s = best?.txns?.h1?.sells ?? 0;
    const base: Omit<Row, 'verdict' | 'reasons'> = {
      trendingRank: i + 1, source, symbol: best?.baseToken?.symbol ?? '?', name: best?.baseToken?.name ?? '?', mint, pairUrl: best?.url ?? null, dex: best?.dexId ?? null,
      ageMinutes: best?.pairCreatedAt ? Math.round((Date.now() - best.pairCreatedAt) / 60000) : null,
      liquidityUsd: best?.liquidity?.usd ?? 0, volumeH1: best?.volume?.h1 ?? 0, buyRatioH1: h1b + h1s > 0 ? h1b / (h1b + h1s) : null, priceUsd: parseFloat(best?.priceUsd ?? '0') || 0,
      top10Share: hs.top10ShareExPool, poolShare: hs.largestShare, lpLockedPct: rc.lpLockedPct, mintAuthority: auth.mintAuthority, freezeAuthority: auth.freezeAuthority,
      deployerRugs: rc.deployerFlag, rugcheckScore: rc.score, rugcheckRisks: rc.risks,
    };
    rows.push({ ...base, ...judge(base) });
    await new Promise(r => setTimeout(r, 250));
  }
  const meta = {
    generatedAt: new Date().toISOString(), tool: 'trapcheck', top: TOP, source: MINTS?.length ? 'manual mints' : 'DexScreener trending (top boosts + latest profiles), Solana only',
    runtimeMs: Date.now() - t0,
    disclaimer: 'Trap check only, not a buy signal. In testing, coins that passed every one of these checks still often lost money; coins that fail them are traps. Verdicts: TRAP = at least one hard failure; CAUTION = soft flags only; NEUTRAL = no traps found by these checks.',
    rules: { TRAP: ['liquidity < $10K', 'mint or freeze authority live', 'LP < 50% locked on < $100K pool', 'top-10 ex-pool > 50%', 'RugCheck danger', 'deployer flagged'], CAUTION: ['age < 30 min', 'top-10 30–50%', 'LP 50–80%', 'buy ratio < 30%', 'RugCheck warn'] },
    counts: { TRAP: rows.filter(r => r.verdict === 'TRAP').length, CAUTION: rows.filter(r => r.verdict === 'CAUTION').length, NEUTRAL: rows.filter(r => r.verdict === 'NEUTRAL').length, UNKNOWN: rows.filter(r => r.verdict === 'UNKNOWN').length },
  };
  if (JSON_OUT) { console.log(JSON.stringify({ meta, tokens: rows }, null, 2)); return; }
  console.log(`trap-check — ${rows.length} trending Solana tokens — ${meta.generatedAt}\n`);
  console.log('#  | verdict | symbol      | age     | liq $    | top10 | LP lock | mint | freeze | reasons');
  for (const r of rows) console.log(`${String(r.trendingRank).padStart(2)} | ${r.verdict.padEnd(7)} | ${r.symbol.slice(0, 11).padEnd(11)} | ${(r.ageMinutes != null ? (r.ageMinutes > 1440 ? Math.round(r.ageMinutes / 1440) + 'd' : r.ageMinutes + 'm') : '?').padEnd(7)} | ${Math.round(r.liquidityUsd).toLocaleString().padStart(8)} | ${(r.top10Share != null ? (r.top10Share * 100).toFixed(0) + '%' : '?').padStart(5)} | ${(r.lpLockedPct != null ? r.lpLockedPct.toFixed(0) + '%' : '?').padStart(7)} | ${r.mintAuthority ? 'LIVE' : 'none'} | ${r.freezeAuthority ? 'LIVE' : 'none'}   | ${r.reasons[0] ?? ''}`);
  console.log(`\n${meta.disclaimer}`);
}
main().catch(e => { console.error(e); process.exit(1); });
