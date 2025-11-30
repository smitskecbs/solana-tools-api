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

function isRateLimitError(e: any): boolean {
  const msg = (e?.message || "").toString().toLowerCase();
  const code = e?.code;
  return (
    code === 429 ||
    msg.includes("too many requests") ||
    msg.includes("rate limit")
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
// /api/cbs-metrics  -> DexScreener pools & liquidity (no 500s)
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
      ok: true,
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
    return res.json({
      mint,
      rpcUrl: RPC_URL,
      ok: false,
      totalPools: 0,
      raydiumCount: 0,
      otherDexCount: 0,
      totalLiquidityUsd: 0,
      raydium: [],
      others: [],
      note:
        e?.message ||
        "Failed to fetch Dex metrics (DexScreener error or network issue).",
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

    // Dex data best-effort
    let pairs: DexPair[] = [];
    let raydiumPairs: DexPair[] = [];
    let totalLiquidityUsd = 0;
    let largestPool: DexPair | null = null;

    try {
      pairs = await fetchDexPairsForMint(mint);
      raydiumPairs = pairs.filter(
        (p) => p.chainId === "solana" && p.dexId.toLowerCase() === "raydium"
      );
      totalLiquidityUsd = raydiumPairs.reduce(
        (acc, p) => acc + (p.liquidity?.usd || 0),
        0
      );
      largestPool = raydiumPairs.reduce<DexPair | null>(
        (acc, p) => {
          const liq = p.liquidity?.usd || 0;
          if (!acc) return p;
          return liq > (acc.liquidity?.usd || 0) ? p : acc;
        },
        null
      );
    } catch (dexErr: any) {
      console.warn("token-safety-check dex error:", dexErr?.message || dexErr);
      // dex info optioneel
    }

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
      reasons.push("No Raydium pools found on DexScreener or request failed.");
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
        "This is a heuristic safety check based on on-chain metadata and (if available) DexScreener data. It is NOT financial advice. Always do your own research.",
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
// Helper: holders via getTokenLargestAccounts ONLY (no extra RPC per account)
// -----------------------------------------------------------------------------

type HolderAgg = {
  owner: string;      // here: token account address
  uiAmount: number;
};

async function aggregateHoldersLargestOnly(
  mintKey: PublicKey
): Promise<HolderAgg[]> {
  const largest = await connection.getTokenLargestAccounts(mintKey, "confirmed");
  const values = largest.value || [];
  if (!values.length) return [];

  const holders: HolderAgg[] = values.map((v) => {
    let uiAmount = v.uiAmount;
    if (uiAmount == null) {
      // fallback: amount / 10^decimals
      uiAmount = Number(v.amount) / Math.pow(10, v.decimals);
    }
    return {
      owner:
        typeof (v.address as any).toBase58 === "function"
          ? (v.address as any).toBase58()
          : String(v.address),
      uiAmount: uiAmount || 0,
    };
  });

  holders.sort((a, b) => b.uiAmount - a.uiAmount);
  return holders;
}

// -----------------------------------------------------------------------------
// /api/holder-info  -> top holders + concentratie (scales for big tokens)
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

    const allHolders = await aggregateHoldersLargestOnly(mintKey);

    let holders = allHolders;
    const totalHolders = holders.length; // aantal largest accounts

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
      note:
        "Based on the largest token accounts only (getTokenLargestAccounts). Each row is a token account, percentages are approximate vs total supply.",
    });
  } catch (e: any) {
    if (isRateLimitError(e)) {
      console.warn("holder-info rate limit:", e?.message || e);
      return res.json({
        mint,
        rpcUrl: RPC_URL,
        rateLimited: true,
        holders: [],
        concentration: { top1: 0, top5: 0, top10: 0 },
        note:
          "Rate limited by RPC for holder-info. Try again in a minute or use a smaller token.",
      });
    }
    if (isScanAbortedError(e)) {
      return res.json({
        mint,
        rpcUrl: RPC_URL,
        scanAborted: true,
        holders: [],
        concentration: { top1: 0, top5: 0, top10: 0 },
        note:
          "RPC scan aborted. This should be rare with getTokenLargestAccounts; try again later.",
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
// /api/whale-tracker  -> whales t.o.v. supply (largest accounts)
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

  const minPct = minPctStr ? parseFloat(minPctStr) : 1; // default 1%
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

    const allHolders = await aggregateHoldersLargestOnly(mintKey);

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
      note:
        "Whales are derived from the largest token accounts (token accounts as 'owners'). Percentages are vs total supply and approximate.",
    });
  } catch (e: any) {
    if (isRateLimitError(e)) {
      console.warn("whale-tracker rate limit:", e?.message || e);
      return res.json({
        mint,
        rpcUrl: RPC_URL,
        rateLimited: true,
        whales: [],
        concentration: { top1: 0, top5: 0, top10: 0 },
        note:
          "Rate limited by RPC for whale-tracker. Try again in a minute or use a smaller token.",
      });
    }
    if (isScanAbortedError(e)) {
      return res.json({
        mint,
        rpcUrl: RPC_URL,
        scanAborted: true,
        whales: [],
        concentration: { top1: 0, top5: 0, top10: 0 },
        note:
          "RPC scan aborted. This should be rare with getTokenLargestAccounts; try again later.",
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
