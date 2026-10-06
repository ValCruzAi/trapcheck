# trapcheck

A read-only trap check for trending Solana tokens. It answers one question: **is this coin an obvious trap?**

It does not trade, does not touch a wallet, and does not tell you what to buy.

```
bun trapcheck.ts --top 10            # table of the current DexScreener trending list
bun trapcheck.ts --top 10 --json     # machine-readable
bun trapcheck.ts --mints <mint,mint> # screen specific tokens
```

## What it checks

| Check | Source | TRAP when |
|---|---|---|
| Pool liquidity | DexScreener | under $10K |
| Mint authority | Solana RPC | still live (supply can be inflated) |
| Freeze authority | Solana RPC | still live (your tokens can be frozen) |
| LP locked or burned | RugCheck | under 50% on a pool under $100K |
| Top-10 holders, excluding the pool | Solana RPC | over 50% of circulating supply |
| Known risk flags, deployer history | RugCheck | any "danger" flag or flagged deployer |

Soft flags give a CAUTION verdict: pair under 30 minutes old, top-10 at 30 to 50%, LP 50 to 80% locked, under 30% buys in the last hour, RugCheck warnings.

## Read this before you use it

**NEUTRAL does not mean buy.** It means no traps were found by these checks, and that is all it means. In testing, coins that passed every check still often lost money. Failing the screen makes a coin a trap. Passing it only means the obvious traps are absent.

## Setup

1. Install [Bun](https://bun.sh).
2. Get a free API key at [helius.dev](https://helius.dev).
3. `cp .env.example .env` and put your key in it. Bun loads `.env` automatically.

About 30 free API calls per 10 tokens. No paid data.

## Output

`--json` returns `{ meta, tokens[] }`. Each token: `trendingRank, source, symbol, name, mint, pairUrl, dex, ageMinutes, liquidityUsd, volumeH1, buyRatioH1, priceUsd, top10Share, poolShare, lpLockedPct, mintAuthority, freezeAuthority, deployerRugs, rugcheckScore, rugcheckRisks, verdict, reasons`. `meta.disclaimer` should travel with any output you publish.

## License

MIT. Software only. Not financial advice. No performance claims are made or implied.
