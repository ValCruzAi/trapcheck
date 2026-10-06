// Minimal DexScreener client (free, no key). Solana only.
const BASE = 'https://api.dexscreener.com';
export interface DexPair {
  chainId: string; dexId: string; url: string; pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  priceUsd: string;
  txns?: { h1?: { buys: number; sells: number } };
  volume?: { h24?: number; h1?: number };
  liquidity?: { usd: number };
  pairCreatedAt?: number;
}
async function get<T>(path: string, tries = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(BASE + path);
      if (r.ok) return (await r.json()) as T;
      last = new Error(`DexScreener ${path}: ${r.status}`);
    } catch (e) { last = e; }
    await new Promise(r => setTimeout(r, 500 * (i + 1)));
  }
  throw last;
}
export type Trending = { address: string; source: 'boost_top' | 'profile_latest' };
export async function getTrending(): Promise<Trending[]> {
  const [boosts, profiles] = await Promise.all([
    get<any[]>('/token-boosts/top/v1').catch(() => []),
    get<any[]>('/token-profiles/latest/v1').catch(() => []),
  ]);
  const seen = new Set<string>(); const out: Trending[] = [];
  for (const [list, source] of [[boosts, 'boost_top'], [profiles, 'profile_latest']] as const)
    for (const t of Array.isArray(list) ? list : [])
      if (t.chainId === 'solana' && !seen.has(t.tokenAddress)) { seen.add(t.tokenAddress); out.push({ address: t.tokenAddress, source }); }
  return out;
}
export async function getPools(mint: string): Promise<DexPair[]> {
  const d = await get<DexPair[] | { pairs: DexPair[] | null }>(`/token-pairs/v1/solana/${mint}`).catch(() => [] as DexPair[]);
  const arr = Array.isArray(d) ? d : d.pairs ?? [];
  return arr.filter(p => p.baseToken?.address === mint);
}
/** Highest-liquidity pool, after dropping pools priced more than 3x from the median (corrupt-pool guard, n>=3). */
export function bestPool(pairs: DexPair[]): DexPair | null {
  const priced = pairs.filter(p => parseFloat(p.priceUsd) > 0);
  if (!priced.length) return null;
  let c = priced;
  if (priced.length >= 3) {
    const s = priced.map(p => parseFloat(p.priceUsd)).sort((a, b) => a - b);
    const m = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
    const sane = priced.filter(p => { const v = parseFloat(p.priceUsd); return (v > m ? v / m : m / v) <= 3; });
    if (sane.length) c = sane;
  }
  return [...c].sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
}
