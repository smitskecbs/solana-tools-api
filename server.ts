import dotenv from "dotenv";
dotenv.config();

import express, { Request, Response } from "express";
import cors from "cors";
import {
  Connection,
  PublicKey,
  LAMPORTS_PER_SOL,
  ParsedAccountData,
} from "@solana/web3.js";
import fetch from "node-fetch";

// -----------------------------------------------------------------------------
// Basic setup
// -----------------------------------------------------------------------------

const RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const PORT = Number(process.env.PORT || 3000);

const connection = new Connection(RPC_URL, "confirmed");
const TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
);

const app = express();
app.use(cors());
app.use(express.json());

function isScanAbortedError(e: any): boolean {
  const msg = (e?.message || "").toString().toLowerCase();
  return (
    msg.includes("scan aborted") ||
    msg.includes("accumulated scan results exceeded the limit")
  );
}

// Simple root
app.get("/", (_req: Request, res: Response) => {
  res.json({
    name: "solana-tools-api",
    status: "ok",
    rpcUrl: RPC_URL,
    endpoints: [
      "/api/wallet-info?address=...",
      "/api/token-info?mint=...",
      "/api/cbs-metrics?mint=...",
      "/api/token-safety-check?mint=...",
      "/api/holder-info?mint=...",
      "/api/whale-tracker?mint=...&minPct=1&limit=20",
    ],
  });
});

// -----------------------------------------------------------------------------
// Helper: DexScreener fetch
// -----------------------------------------------------------------------------

type DexPair = {
  chainId: string;
  dexId: string;
  url: string;
  pairAddress: string;
  baseToken: { address: string; symbol: string; name: string };
  quoteToken: { address: string; symbol: string; name: string };
  priceUsd?: string;
  liquidity?: { usd?: number; base?: number; quote?: number };
  volume?: { h24?: number; h6?: number; h1?: number };
  fdv?: number;
  marketCap?: number;
  [key: string]: any;
};

async function fetchDexPairsForMint(mint: string): Promise<DexPair[]> {
  const url = `https://api.dexscreener.com/latest/dex/tokens/${mint}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`DexScreener error ${res.status} for ${mint}`);
  }
  const data: any = await res.json();
  const pairs: DexPair[] = Array.isArray(data.pairs) ? data.pairs : [];
  return pairs;
}

// -----------------------------------------------------------------------------
// /api/wallet-info  -> SOL + SPL balances
// -----------------------------------------------------------------------------

app.get("/api/wallet-info", async (req: Request, res: Response) => {
  const address = (req.query.address as string | undefined)?.trim();

  if (!address) {
    return res.status(400).json({ error: "Missing address query param" });
  }

  let pubkey: PublicKey;
  try {
    pubkey = new PublicKey(address);
  } catch {
    return res.status(400).json({ error: "Invalid Solana address" });
  }

  try {
    const lamports = await connection.getBalance(pubkey, "confirmed");
    const sol = lamports / LAMPORTS_PER_SOL;

    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
      pubkey,
      { programId: TOKEN_PROGRAM_ID },
      "confirmed"
    );

    const tokens = tokenAccounts.value
      .map((ta) => {
        const info = ta.account.data as ParsedAccountData;
        if (info.program !== "spl-token" || info.parsed.type !== "account") {
          return null;
        }

        const parsed: any = info.parsed.info;
        const mintStr: string = parsed.mint;
        const tokenAmount = parsed.tokenAmount;

        const decimals: number = tokenAmount.decimals;
        const amountRaw: string = tokenAmount.amount;

        let uiAmount = 0;
        try {
          uiAmount = Number(amountRaw) / Math.pow(10, decimals);
        } catch {
          uiAmount = 0;
        }

        if (!uiAmount || uiAmount === 0) return null;

        return {
          mint: mintStr,
          tokenAccount: ta.pubkey.toBase58(),
          amountRaw,
          uiAmount,
          decimals,
          isNative: false,
        };
      })
      .filter((t) => t !== null)
      .sort((a: any, b: any) => (b.uiAmount || 0) - (a.uiAmount || 0));

    return res.json({
      address,
      rpcUrl: RPC_URL,
      lamports,
      sol,
      tokens,
    });
  } catch (e: any) {
    console.error("wallet-info error:", e);
    return res.status(500).json({
      error: "Failed to fetch wallet info",
      message: e?.message || String(e),
    });
  }
});

// -----------------------------------------------------------------------------
// /api/token-info  -> mint metadata / supply / authorities
// -----------------------------------------------------------------------------

app.get("/api/token-info", async (req: Request, res: Response) => {
  const mint = (req.query.mint as string | undefined)?.trim();

  if (!mint) {
    return res.status(400).json({ error: "Missing mint query param" });
  }

  let mintKey: PublicKey;
  try {
    mintKey = new PublicKey(mint);
  } catch {
    return res.status(400).json({ error: "Invalid mint address" });
  }

  try {
    const parsed = await connection.getParsedAccountInfo(mintKey, "confirmed");
    if (!parsed.value) {
      return res.status(404).json({
        error: "Mint account not found",
        mint,
      });
    }

    const data = parsed.value.data as ParsedAccountData;
    if (data.program !== "spl-token" || data.parsed.type !== "mint") {
      return res.status(400).json({
        error: "Account is not an SPL mint",
        mint,
      });
    }

    const info: any = data.parsed.info;
    const decimals: number = info.decimals;
    const supplyRaw: string = info.supply;
    const supply =
      decimals >= 0
        ? Number(supplyRaw) / Math.pow(10, decimals)
        : Number(supplyRaw);
    const mintAuthority = info.mintAuthority ?? null;
    const freezeAuthority = info.freezeAuthority ?? null;
    const isInitialized = !!info.isInitialized;

    return res.json({
      mint,
      rpcUrl: RPC_URL,
      decimals,
      supplyRaw,
      supply,
      mintAuthority,
      freezeAuthority,
      isInitialized,
    });
  } catch (e: any) {
    console.error("token-info error:", e);
    return res.status(500).json({
      error: "Failed to fetch token info",
      message: e?.message || String(e),
    });
  }
});

// -----------------------------------------------------------------------------
// /api/cbs-metrics  -> DexScreener pools & liquidity
// -----------------------------------------------------------------------------

app.get("/api/cbs-metrics", async (req: Request, res: Response) => {
  const mint = (req.query.mint as string | undefined)?.trim();

  if (!mint) {
    return res.status(400).json({ error: "Missing mint query param" });
  }

  try {
    const pairs = await fetchDexPairsForMint(mint);

    const raydiumPairs = pairs.filter(
      (p) => p.chainId === "solana" && p.dexId.toLowerCase() === "raydium"
    );

    const summary = raydiumPairs.map((p) => ({
      chainId: p.chainId,
      dexId: p.dexId,
      url: p.url,
      pairAddress: p.pairAddress,
      baseToken: p.baseToken,
      quoteToken: p.quoteToken,
      priceUsd: p.priceUsd,
      liquidityUsd: p.liquidity?.usd ?? null,
      volume24h: p.volume?.h24 ?? null,
      fdv: p.fdv ?? p.marketCap ?? null,
    }));

    const totalLiquidityUsd = summary.reduce(
      (acc, p) => acc + (p.liquidityUsd || 0),
      0
    );

    return res.json({
      mint,
      rpcUrl: RPC_URL,
      totalPools: pairs.length,
      raydiumCount: raydiumPairs.length,
      otherDexCount: pairs.length - raydiumPairs.length,
      totalLiquidityUsd,
      raydium: summary,
      others: pairs
        .filter((p) => p.dexId.toLowerCase() !== "raydium")
        .map((p) => ({
          chainId: p.chainId,
          dexId: p.dexId,
          url: p.url,
          pairAddress: p.pairAddress,
          baseToken: p.baseToken,
          quoteToken: p.quoteToken,
          priceUsd: p.priceUsd,
          liquidityUsd: p.liquidity?.usd ?? null,
        })),
    });
  } catch (e: any) {
    console.error("cbs-metrics error:", e);
    return res.status(500).json({
      error: "Failed to fetch Dex metrics",
      message: e?.message || String(e),
    });
  }
});

// -----------------------------------------------------------------------------
// /api/token-safety-check  -> heuristische risico-analyse
// -----------------------------------------------------------------------------

app.get("/api/token-safety-check", async (req: Request, res: Response) => {
  const mint = (req.query.mint as string | undefined)?.trim();

  if (!mint) {
    return res.status(400).json({ error: "Missing mint query param" });
  }

  let mintKey: PublicKey;
  try {
    mintKey = new PublicKey(mint);
  } catch {
    return res.status(400).json({ error: "Invalid mint address" });
  }

  try {
    const parsed = await connection.getParsedAccountInfo(mintKey, "confirmed");
    if (!parsed.value) {
      return res.status(404).json({
        error: "Mint account not found",
        mint,
      });
    }

    const data = parsed.value.data as ParsedAccountData;
    if (data.program !== "spl-token" || data.parsed.type !== "mint") {
      return res.status(400).json({
        error: "Account is not an SPL mint",
        mint,
      });
    }

    const info: any = data.parsed.info;
    const decimals: number = info.decimals;
    const supplyRaw: string = info.supply;
    const supply =
      decimals >= 0
        ? Number(supplyRaw) / Math.pow(10, decimals)
        : Number(supplyRaw);
    const mintAuthority = info.mintAuthority ?? null;
    const freezeAuthority = info.freezeAuthority ?? null;
    const isInitialized = !!info.isInitialized;

    const pairs = await fetchDexPairsForMint(mint);
    const raydiumPairs = pairs.filter(
      (p) => p.chainId === "solana" && p.dexId.toLowerCase() === "raydium"
    );
    const totalLiquidityUsd = raydiumPairs.reduce(
      (acc, p) => acc + (p.liquidity?.usd || 0),
      0
    );
    const largestPool = raydiumPairs.reduce<DexPair | null>(
      (acc, p) => {
        const liq = p.liquidity?.usd || 0;
        if (!acc) return p;
        return liq > (acc.liquidity?.usd || 0) ? p : acc;
      },
      null
    );

    const reasons: string[] = [];
    const immutableMint = mintAuthority === null;
    const canFreeze = freezeAuthority !== null;
    const hasRaydiumPool = raydiumPairs.length > 0;

    if (immutableMint) {
      reasons.push("Mint authority revoked (immutable supply).");
    } else {
      reasons.push("Mint authority is still set (mintable token).");
    }

    if (!canFreeze) {
      reasons.push("Freeze authority revoked (no freeze control).");
    } else {
      reasons.push("Freeze authority is still set.");
    }

    if (hasRaydiumPool) {
      reasons.push(
        `Raydium pools found (${raydiumPairs.length}), total liquidity ≈ $${totalLiquidityUsd.toFixed(
          2
        )}.`
      );
    } else {
      reasons.push("No Raydium pools found on DexScreener.");
    }

    let riskLevel: "low" | "medium" | "high" = "medium";
    let lowLiquidity = false;
    let veryLowLiquidity = false;

    if (totalLiquidityUsd < 200) {
      veryLowLiquidity = true;
      lowLiquidity = true;
    } else if (totalLiquidityUsd < 1000) {
      lowLiquidity = true;
    }

    if (!hasRaydiumPool || veryLowLiquidity || !immutableMint) {
      riskLevel = "high";
    } else if (lowLiquidity || canFreeze) {
      riskLevel = "medium";
    } else {
      riskLevel = "low";
    }

    return res.json({
      mint,
      rpcUrl: RPC_URL,
      onChain: {
        decimals,
        supplyRaw,
        supply,
        mintAuthority,
        freezeAuthority,
        isInitialized,
      },
      dex: {
        totalPools: pairs.length,
        totalLiquidityUsd,
        largestPool: largestPool
          ? {
              dexId: largestPool.dexId,
              pairAddress: largestPool.pairAddress,
              liquidityUsd: largestPool.liquidity?.usd || 0,
              url: largestPool.url,
            }
          : null,
      },
      safety: {
        immutableMint,
        canFreeze,
        hasRaydiumPool,
        lowLiquidity,
        veryLowLiquidity,
        riskLevel,
        reasons,
      },
      disclaimer:
        "This is a heuristic safety check based on on-chain metadata and DexScreener data. It is NOT financial advice. Always do your own research.",
    });
  } catch (e: any) {
    console.error("token-safety-check error:", e);
    return res.status(500).json({
      error: "Failed to run token safety check",
      message: e?.message || String(e),
    });
  }
});

// -----------------------------------------------------------------------------
// Helper: aggregate holders by owner (full scan + fallback top accounts)
// -----------------------------------------------------------------------------

type HolderAgg = {
  owner: string;
  uiAmount: number;
};

async function aggregateHoldersForMint(
  mintKey: PublicKey
): Promise<{
  holders: HolderAgg[];
  usedFallback: boolean;
}> {
  // 1) probeer volledige scan
  try {
    const tokenAccounts = await connection.getParsedProgramAccounts(
      TOKEN_PROGRAM_ID,
      {
        commitment: "confirmed",
        filters: [
          { dataSize: 165 },
          {
            memcmp: {
              offset: 0,
              bytes: mintKey.toBase58(),
            },
          },
        ],
      }
    );

    const holdersMap = new Map<string, HolderAgg>();

    for (const ta of tokenAccounts) {
      const info = ta.account.data as ParsedAccountData;
      if (info.program !== "spl-token" || info.parsed.type !== "account") {
        continue;
      }

      const parsed: any = info.parsed.info;
      const owner: string = parsed.owner;
      const tokenAmount = parsed.tokenAmount;

      const accDecimals: number = tokenAmount.decimals;
      const amountRaw: string = tokenAmount.amount;

      let uiAmount = 0;
      try {
        uiAmount = Number(amountRaw) / Math.pow(10, accDecimals);
      } catch {
        uiAmount = 0;
      }

      if (!uiAmount || uiAmount === 0) continue;

      const prev = holdersMap.get(owner);
      if (prev) {
        prev.uiAmount += uiAmount;
      } else {
        holdersMap.set(owner, { owner, uiAmount });
      }
    }

    const holders = Array.from(holdersMap.values()).sort(
      (a, b) => b.uiAmount - a.uiAmount
    );

    return { holders, usedFallback: false };
  } catch (e: any) {
    if (!isScanAbortedError(e)) {
      throw e;
    }

    // 2) fallback: top token accounts via getTokenLargestAccounts
    const largest = await connection.getTokenLargestAccounts(mintKey, "confirmed");
    const values = largest.value || [];

    if (!values.length) {
      return { holders: [], usedFallback: true };
    }

    const accountPubkeys = values.map((v) => v.address);
    const parsedInfos = await Promise.all(
      accountPubkeys.map((pk) => connection.getParsedAccountInfo(pk, "confirmed"))
    );

    const holdersMap = new Map<string, HolderAgg>();

    values.forEach((v, idx) => {
      const infoWrapper = parsedInfos[idx];
      const uiAmount = v.uiAmount || 0;
      if (!uiAmount || uiAmount === 0) return;

      const parsedData = infoWrapper.value?.data as ParsedAccountData | undefined;
      if (!parsedData || parsedData.program !== "spl-token") return;
      const parsed: any = parsedData.parsed.info;
      const owner: string = parsed.owner;

      const prev = holdersMap.get(owner);
      if (prev) {
        prev.uiAmount += uiAmount;
      } else {
        holdersMap.set(owner, { owner, uiAmount });
      }
    });

    const holders = Array.from(holdersMap.values()).sort(
      (a, b) => b.uiAmount - a.uiAmount
    );

    return { holders, usedFallback: true };
  }
}

// -----------------------------------------------------------------------------
// /api/holder-info  -> top holders + concentratie
// -----------------------------------------------------------------------------

app.get("/api/holder-info", async (req: Request, res: Response) => {
  const mint = (req.query.mint as string | undefined)?.trim();
  const minStr = (req.query.min as string | undefined)?.trim();
  const limitStr = (req.query.limit as string | undefined)?.trim();

  if (!mint) {
    return res.status(400).json({ error: "Missing mint query param" });
  }

  let mintKey: PublicKey;
  try {
    mintKey = new PublicKey(mint);
  } catch {
    return res.status(400).json({ error: "Invalid mint address" });
  }

  const minAmount = minStr ? parseFloat(minStr) : 0;
  const limit = limitStr ? parseInt(limitStr, 10) : 100;

  try {
    const parsedMint = await connection.getParsedAccountInfo(
      mintKey,
      "confirmed"
    );
    if (!parsedMint.value) {
      return res.status(404).json({
        error: "Mint account not found",
        mint,
      });
    }

    const mintData = parsedMint.value.data as ParsedAccountData;
    if (mintData.program !== "spl-token" || mintData.parsed.type !== "mint") {
      return res.status(400).json({
        error: "Account is not an SPL mint",
        mint,
      });
    }

    const mInfo: any = mintData.parsed.info;
    const decimals: number = mInfo.decimals;
    const supplyRaw: string = mInfo.supply;
    const supply =
      decimals >= 0
        ? Number(supplyRaw) / Math.pow(10, decimals)
        : Number(supplyRaw);

    const { holders: allHolders, usedFallback } =
      await aggregateHoldersForMint(mintKey);

    let holders = allHolders;
    const totalHolders = holders.length;

    if (minAmount > 0) {
      holders = holders.filter((h) => h.uiAmount >= minAmount);
    }

    const filteredCount = holders.length;
    const top = holders.slice(0, isNaN(limit) ? 100 : limit);

    function pctOfSupply(count: number): number {
      if (!supply || supply <= 0) return 0;
      const slice = holders.slice(0, count);
      const sum = slice.reduce((acc, h) => acc + h.uiAmount, 0);
      return (sum / supply) * 100;
    }

    const concentration = {
      top1: pctOfSupply(1),
      top5: pctOfSupply(5),
      top10: pctOfSupply(10),
    };

    const holdersWithPct = top.map((h) => ({
      owner: h.owner,
      uiAmount: h.uiAmount,
      percentageOfSupply: supply > 0 ? (h.uiAmount / supply) * 100 : 0,
    }));

    return res.json({
      mint,
      rpcUrl: RPC_URL,
      decimals,
      supplyRaw,
      supply,
      totalHolders,
      filteredCount,
      topCount: holdersWithPct.length,
      concentration,
      holders: holdersWithPct,
      note: usedFallback
        ? "RPC scan aborted for full holder list. Falling back to largest token accounts only. Percentages are approximate."
        : "This endpoint aggregates all token accounts by owner. Percentages are approximate and based on current total supply.",
    });
  } catch (e: any) {
    if (isScanAbortedError(e)) {
      return res.status(400).json({
        error: "SCAN_ABORTED",
        message:
          "RPC scan aborted. Try again later or with a more specific filter.",
      });
    }
    console.error("holder-info error:", e);
    return res.status(500).json({
      error: "Failed to fetch holder info",
      message: e?.message || String(e),
    });
  }
});

// -----------------------------------------------------------------------------
// /api/whale-tracker  -> whales op basis van holder-aggregatie
// -----------------------------------------------------------------------------

app.get("/api/whale-tracker", async (req: Request, res: Response) => {
  const mint = (req.query.mint as string | undefined)?.trim();
  const minPctStr = (req.query.minPct as string | undefined)?.trim();
  const limitStr = (req.query.limit as string | undefined)?.trim();

  if (!mint) {
    return res.status(400).json({ error: "Missing mint query param" });
  }

  let mintKey: PublicKey;
  try {
    mintKey = new PublicKey(mint);
  } catch {
    return res.status(400).json({ error: "Invalid mint address" });
  }

  const minPct = minPctStr ? parseFloat(minPctStr) : 1; // default 1% van supply
  const limit = limitStr ? parseInt(limitStr, 10) : 20;

  try {
    const parsedMint = await connection.getParsedAccountInfo(
      mintKey,
      "confirmed"
    );
    if (!parsedMint.value) {
      return res.status(404).json({
        error: "Mint account not found",
        mint,
      });
    }

    const mintData = parsedMint.value.data as ParsedAccountData;
    if (mintData.program !== "spl-token" || mintData.parsed.type !== "mint") {
      return res.status(400).json({
        error: "Account is not an SPL mint",
        mint,
      });
    }

    const mInfo: any = mintData.parsed.info;
    const decimals: number = mInfo.decimals;
    const supplyRaw: string = mInfo.supply;
    const supply =
      decimals >= 0
        ? Number(supplyRaw) / Math.pow(10, decimals)
        : Number(supplyRaw);

    const { holders: allHolders, usedFallback } =
      await aggregateHoldersForMint(mintKey);

    const whales = allHolders
      .filter((h) => {
        if (!supply || supply <= 0) return false;
        const pct = (h.uiAmount / supply) * 100;
        return pct >= minPct;
      })
      .sort((a, b) => b.uiAmount - a.uiAmount)
      .slice(0, isNaN(limit) ? 20 : limit);

    function pctOfSupply(count: number): number {
      if (!supply || supply <= 0) return 0;
      const slice = allHolders.slice(0, count);
      const sum = slice.reduce((acc, h) => acc + h.uiAmount, 0);
      return (sum / supply) * 100;
    }

    const concentration = {
      top1: pctOfSupply(1),
      top5: pctOfSupply(5),
      top10: pctOfSupply(10),
    };

    const whalesWithPct = whales.map((h) => ({
      owner: h.owner,
      uiAmount: h.uiAmount,
      percentageOfSupply: supply > 0 ? (h.uiAmount / supply) * 100 : 0,
    }));

    return res.json({
      mint,
      rpcUrl: RPC_URL,
      decimals,
      supplyRaw,
      supply,
      minPct,
      concentration,
      whales: whalesWithPct,
      note: usedFallback
        ? "RPC scan aborted for full holder list. Whale data is based on largest token accounts only (approximate)."
        : "Whales are wallets holding at least minPct% of total supply, based on aggregated token accounts.",
    });
  } catch (e: any) {
    if (isScanAbortedError(e)) {
      return res.status(400).json({
        error: "SCAN_ABORTED",
        message:
          "RPC scan aborted because this token has too many accounts. Whale-tracker works best for mid/small-cap SPL tokens.",
      });
    }
    console.error("whale-tracker error:", e);
    return res.status(500).json({
      error: "Failed to fetch whale tracker info",
      message: e?.message || String(e),
    });
  }
});

// -----------------------------------------------------------------------------
// Start server
// -----------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(
    `solana-tools-api listening on port ${PORT} (RPC=${RPC_URL})`
  );
});

