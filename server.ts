import dotenv from "dotenv";
dotenv.config();
import "dotenv/config";
import express from "express";
import cors from "cors";
import {
  Connection,
  PublicKey,
  LAMPORTS_PER_SOL,
  ParsedAccountData
} from "@solana/web3.js";

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const RPC_URL =
  process.env.RPC_URL || "https://api.mainnet-beta.solana.com";

const app = express();

app.use(
  cors({
    origin: "*"
  })
);
app.use(express.json());

const connection = new Connection(RPC_URL, "confirmed");

// ---------- WALLET INFO ----------
app.get("/api/wallet-info", async (req, res) => {
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

    return res.json({
      address,
      rpcUrl: RPC_URL,
      lamports,
      sol
    });
  } catch (e: any) {
    console.error("wallet-info error:", e);
    return res.status(500).json({
      error: "Failed to fetch wallet info",
      message: e?.message || String(e)
    });
  }
});

// ---------- TOKEN INFO ----------
app.get("/api/token-info", async (req, res) => {
  const mintDefault = "B9z8cEWFmc7LvQtjKsaLoKqW5MJmGRCWqs1DPKupCfkk"; // CBS
  const mintStr = ((req.query.mint as string | undefined) || mintDefault).trim();

  let mint: PublicKey;
  try {
    mint = new PublicKey(mintStr);
  } catch {
    return res.status(400).json({ error: "Invalid mint address" });
  }

  try {
    const info = await connection.getParsedAccountInfo(mint, "confirmed");
    if (!info.value) {
      return res.status(404).json({ error: "Mint account not found" });
    }

    const data = info.value.data as ParsedAccountData;
    if (data.program !== "spl-token" || data.parsed.type !== "mint") {
      return res.status(400).json({
        error: "Account is not a SPL mint",
        program: data.program,
        type: data.parsed.type
      });
    }

    const parsed = data.parsed.info as any;
    const decimals: number = parsed.decimals;
    const supplyRaw: string = parsed.supply; // integer as string
    const supplyBig = BigInt(supplyRaw);
    const divisor = BigInt(10) ** BigInt(decimals);
    const uiSupply = Number(supplyBig) / Number(divisor);

    const mintAuthority = parsed.mintAuthority ?? null;
    const freezeAuthority = parsed.freezeAuthority ?? null;
    const isInitialized = parsed.isInitialized ?? null;

    return res.json({
      mint: mintStr,
      rpcUrl: RPC_URL,
      decimals,
      supplyRaw,
      supply: uiSupply,
      mintAuthority,
      freezeAuthority,
      isInitialized
    });
  } catch (e: any) {
    console.error("token-info error:", e);
    return res.status(500).json({
      error: "Failed to fetch token info",
      message: e?.message || String(e)
    });
  }
});

// ---------- DEX METRICS (DexScreener) ----------
type DexToken = {
  address?: string;
  symbol?: string;
  name?: string;
};

type DexLiquidity = {
  usd?: number;
  base?: number;
  quote?: number;
};

type DexVolume = {
  h24?: number;
};

type DexPair = {
  dexId?: string;
  chainId?: string;
  pairAddress?: string;
  baseToken?: DexToken;
  quoteToken?: DexToken;
  priceUsd?: string;
  liquidity?: DexLiquidity;
  volume?: DexVolume;
  fdv?: number;
  url?: string;
};

app.get("/api/cbs-metrics", async (req, res) => {
  const mintDefault = "B9z8cEWFmc7LvQtjKsaLoKqW5MJmGRCWqs1DPKupCfkk"; // CBS
  const mint = ((req.query.mint as string | undefined) || mintDefault).trim();

  const url = `https://api.dexscreener.com/latest/dex/tokens/${mint}`;

  try {
    const r = await fetch(url as any);
    if (!r.ok) {
      const text = await r.text();
      return res.status(r.status).json({
        error: "DexScreener error",
        status: r.status,
        body: text
      });
    }

    const { pairs } = (await r.json()) as { pairs?: DexPair[] };
    const pools = pairs ?? [];

    const raydium = pools.filter((p) =>
      (p.dexId || "").toLowerCase().includes("raydium")
    );
    const others = pools.filter(
      (p) => !(p.dexId || "").toLowerCase().includes("raydium")
    );

    return res.json({
      mint,
      totalPools: pools.length,
      raydiumCount: raydium.length,
      otherDexCount: others.length,
      raydium,
      others
    });
  } catch (e: any) {
    console.error("cbs-metrics error:", e);
    return res.status(500).json({
      error: "Failed to fetch metrics from DexScreener",
      message: e?.message || String(e)
    });
  }
});

// ---------- TOKEN SAFETY CHECK ----------
app.get("/api/token-safety-check", async (req, res) => {
  const mintDefault = "B9z8cEWFmc7LvQtjKsaLoKqW5MJmGRCWqs1DPKupCfkk"; // CBS
  const mintStr = ((req.query.mint as string | undefined) || mintDefault).trim();

  let mint: PublicKey;
  try {
    mint = new PublicKey(mintStr);
  } catch {
    return res.status(400).json({ error: "Invalid mint address" });
  }

  try {
    // 1) On-chain mint info
    const info = await connection.getParsedAccountInfo(mint, "confirmed");
    if (!info.value) {
      return res.status(404).json({ error: "Mint account not found" });
    }

    const data = info.value.data as ParsedAccountData;
    if (data.program !== "spl-token" || data.parsed.type !== "mint") {
      return res.status(400).json({
        error: "Account is not a SPL mint",
        program: data.program,
        type: data.parsed.type
      });
    }

    const parsed = data.parsed.info as any;
    const decimals: number = parsed.decimals;
    const supplyRaw: string = parsed.supply;
    const supplyBig = BigInt(supplyRaw);
    const divisor = BigInt(10) ** BigInt(decimals);
    const uiSupply = Number(supplyBig) / Number(divisor);

    const mintAuthority = parsed.mintAuthority ?? null;
    const freezeAuthority = parsed.freezeAuthority ?? null;
    const isInitialized = parsed.isInitialized ?? null;

    // 2) DexScreener pools
    const dsUrl = `https://api.dexscreener.com/latest/dex/tokens/${mintStr}`;
    const r = await fetch(dsUrl as any);
    let pools: DexPair[] = [];
    if (r.ok) {
      const { pairs } = (await r.json()) as { pairs?: DexPair[] };
      pools = pairs ?? [];
    }

    const raydium = pools.filter((p) =>
      (p.dexId || "").toLowerCase().includes("raydium")
    );
    const totalLiquidityUsd = pools.reduce(
      (acc, p) => acc + (p.liquidity?.usd || 0),
      0
    );
    const largestPool = pools.reduce<DexPair | null>((best, p) => {
      const cur = p.liquidity?.usd || 0;
      const bestVal = best?.liquidity?.usd || 0;
      return cur > bestVal ? p : best;
    }, null);

    // 3) Heuristics
    const immutableMint = mintAuthority === null;
    const canFreeze = freezeAuthority !== null;
    const hasRaydiumPool = raydium.length > 0;
    const lowLiquidity = totalLiquidityUsd < 1000; // arbitrair
    const veryLowLiquidity = totalLiquidityUsd < 100;

    const reasons: string[] = [];

    if (immutableMint) {
      reasons.push("Mint authority revoked (immutable supply).");
    } else {
      reasons.push("Mint authority is still active (supply can change).");
    }

    if (canFreeze) {
      reasons.push("Freeze authority is set (accounts can be frozen).");
    } else {
      reasons.push("Freeze authority revoked (no freeze control).");
    }

    if (hasRaydiumPool) {
      reasons.push(
        `Raydium pools found (${raydium.length}), total liquidity ≈ $${totalLiquidityUsd.toFixed(
          2
        )}.`
      );
    } else {
      reasons.push("No Raydium pools found on DexScreener.");
    }

    if (veryLowLiquidity) {
      reasons.push(
        "Very low liquidity (< $100), price can be extremely volatile and easy to manipulate."
      );
    } else if (lowLiquidity) {
      reasons.push(
        "Low liquidity (< $1000), price impact for trades can be high."
      );
    }

    // Simple risk label
    let riskLevel: "low" | "medium" | "high" = "medium";

    if (immutableMint && !canFreeze && hasRaydiumPool && !veryLowLiquidity) {
      riskLevel = "low";
    } else if (!immutableMint || canFreeze || veryLowLiquidity) {
      riskLevel = "high";
    } else {
      riskLevel = "medium";
    }

    return res.json({
      mint: mintStr,
      rpcUrl: RPC_URL,
      onChain: {
        decimals,
        supplyRaw,
        supply: uiSupply,
        mintAuthority,
        freezeAuthority,
        isInitialized
      },
      dex: {
        totalPools: pools.length,
        totalLiquidityUsd,
        largestPool: largestPool
          ? {
              dexId: largestPool.dexId,
              pairAddress: largestPool.pairAddress,
              liquidityUsd: largestPool.liquidity?.usd || 0,
              url: largestPool.url
            }
          : null
      },
      safety: {
        immutableMint,
        canFreeze,
        hasRaydiumPool,
        lowLiquidity,
        veryLowLiquidity,
        riskLevel,
        reasons
      },
      disclaimer:
        "This is a heuristic safety check based on on-chain metadata and DexScreener data. It is NOT financial advice. Always do your own research."
    });
  } catch (e: any) {
    console.error("token-safety-check error:", e);
    return res.status(500).json({
      error: "Failed to run token safety check",
      message: e?.message || String(e)
    });
  }
});

// ---------- ROOT ----------
app.get("/", (_req, res) => {
  res.send("Solana Tools API server is running");
});

app.listen(PORT, () => {
  console.log(`API server listening on http://localhost:${PORT}`);
  console.log(`RPC_URL = ${RPC_URL}`);
});
