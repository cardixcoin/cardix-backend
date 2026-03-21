import "dotenv/config";
import express from "express";
import cors from "cors";
import bs58 from "bs58";
import {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL
} from "@solana/web3.js";
import {
  getOrCreateAssociatedTokenAccount,
  transferChecked
} from "@solana/spl-token";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const requiredEnv = [
  "RPC_URL",
  "DISTRIBUTOR_PRIVATE_KEY",
  "CARDIX_MINT",
  "TREASURY_WALLET",
  "CARDIX_PRICE_USD",
  "CARDIX_DECIMALS"
];

for (const key of requiredEnv) {
  if (!process.env[key]) {
    throw new Error(`Missing ENV: ${key}`);
  }
}

const connection = new Connection(process.env.RPC_URL, "confirmed");

let distributor;

try {
  const privateKey = process.env.DISTRIBUTOR_PRIVATE_KEY.trim();
  distributor = Keypair.fromSecretKey(bs58.decode(privateKey));
  console.log("✅ Distributor wallet:", distributor.publicKey.toBase58());
} catch (err) {
  console.error("❌ INVALID PRIVATE KEY");
  throw err;
}

const MINT = new PublicKey(process.env.CARDIX_MINT);
const TREASURY = new PublicKey(process.env.TREASURY_WALLET);
const PRICE = Number(process.env.CARDIX_PRICE_USD);   // es. 0.0001
const DECIMALS = Number(process.env.CARDIX_DECIMALS); // es. 6
const FIXED_SOL_PRICE = 80; // 1 SOL = 80 USD

// Anti-spam / anti-bot
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 20;
const MAX_CREATE_TX_PER_WINDOW = 10;
const MIN_SOL_AMOUNT = 0.01;
const MAX_SOL_AMOUNT = 100;
const DUPLICATE_REQUEST_WINDOW_MS = 30 * 1000;

// In-memory stores
const processedTransactions = new Set();
const inProgressTransactions = new Set();
const rateLimitStore = new Map();
const recentCreateRequests = new Map();
const sales = [];

// --------------------------
// Helpers
// --------------------------
function getClientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length > 0) {
    return xff.split(",")[0].trim();
  }
  return req.socket.remoteAddress || "unknown";
}

function cleanupRateStore() {
  const now = Date.now();
  for (const [ip, data] of rateLimitStore.entries()) {
    if (now - data.windowStart > RATE_LIMIT_WINDOW_MS) {
      rateLimitStore.delete(ip);
    }
  }
}

function rateLimit(req, res, next) {
  cleanupRateStore();

  const ip = getClientIp(req);
  const now = Date.now();

  if (!rateLimitStore.has(ip)) {
    rateLimitStore.set(ip, {
      windowStart: now,
      count: 1,
      createTxCount: req.path === "/create-transaction" ? 1 : 0
    });
    return next();
  }

  const entry = rateLimitStore.get(ip);

  if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    entry.windowStart = now;
    entry.count = 1;
    entry.createTxCount = req.path === "/create-transaction" ? 1 : 0;
    return next();
  }

  entry.count += 1;
  if (req.path === "/create-transaction") {
    entry.createTxCount += 1;
  }

  if (entry.count > MAX_REQUESTS_PER_WINDOW) {
    return res.status(429).json({
      error: "Too many requests. Please slow down."
    });
  }

  if (entry.createTxCount > MAX_CREATE_TX_PER_WINDOW) {
    return res.status(429).json({
      error: "Too many transaction creation attempts. Please wait a moment."
    });
  }

  return next();
}

function blockDuplicateCreateRequest(ip, buyer, amount) {
  const key = `${ip}:${buyer}:${amount}`;
  const now = Date.now();
  const last = recentCreateRequests.get(key);

  if (last && now - last < DUPLICATE_REQUEST_WINDOW_MS) {
    return true;
  }

  recentCreateRequests.set(key, now);

  // cleanup old
  for (const [k, ts] of recentCreateRequests.entries()) {
    if (now - ts > DUPLICATE_REQUEST_WINDOW_MS) {
      recentCreateRequests.delete(k);
    }
  }

  return false;
}

function maskWallet(address) {
  if (!address || address.length < 10) return address || "";
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

function addSale(record) {
  sales.unshift(record);
  if (sales.length > 100) {
    sales.pop();
  }
}

function getStats() {
  const totalSol = sales.reduce((sum, s) => sum + Number(s.solAmount || 0), 0);
  const totalTokens = sales.reduce((sum, s) => sum + Number(s.tokens || 0), 0);

  return {
    success: true,
    totalPurchases: sales.length,
    totalSolRaised: Number(totalSol.toFixed(6)),
    totalTokensSold: Number(totalTokens.toFixed(2)),
    latestSales: sales.slice(0, 10)
  };
}

async function getConfirmedTransaction(signature) {
  return connection.getTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0
  });
}

async function extractPurchaseData(signature, buyer) {
  const tx = await getConfirmedTransaction(signature);

  if (!tx) {
    throw new Error("Transaction not found");
  }

  if (tx.meta?.err) {
    throw new Error("Transaction failed");
  }

  const buyerPk = new PublicKey(buyer);
  const accountKeys = tx.transaction.message.getAccountKeys().staticAccountKeys;

  const buyerIndex = accountKeys.findIndex((k) => k.equals(buyerPk));
  const treasuryIndex = accountKeys.findIndex((k) => k.equals(TREASURY));

  if (buyerIndex === -1) {
    throw new Error("Buyer wallet not found in transaction");
  }

  if (treasuryIndex === -1) {
    throw new Error("Treasury wallet not found in transaction");
  }

  const preBalances = tx.meta.preBalances;
  const postBalances = tx.meta.postBalances;

  const receivedLamports = postBalances[treasuryIndex] - preBalances[treasuryIndex];

  if (receivedLamports <= 0) {
    throw new Error("No SOL received in treasury");
  }

  const solAmount = receivedLamports / LAMPORTS_PER_SOL;
  const usdValue = solAmount * FIXED_SOL_PRICE;
  const tokens = usdValue / PRICE;
  const amountToSend = BigInt(Math.floor(tokens * 10 ** DECIMALS));

  if (amountToSend <= 0n) {
    throw new Error("Token amount is zero");
  }

  return {
    buyerPk,
    solAmount,
    usdValue,
    tokens,
    amountToSend
  };
}

async function processPurchase(signature, buyer) {
  if (processedTransactions.has(signature)) {
    throw new Error("Transaction already processed");
  }

  if (inProgressTransactions.has(signature)) {
    throw new Error("Transaction is already being processed");
  }

  inProgressTransactions.add(signature);

  try {
    const { buyerPk, solAmount, usdValue, tokens, amountToSend } =
      await extractPurchaseData(signature, buyer);

    console.log("💰 SOL received:", solAmount);
    console.log("💵 USD value:", usdValue);
    console.log("🪙 Tokens to send:", tokens);

    const from = await getOrCreateAssociatedTokenAccount(
      connection,
      distributor,
      MINT,
      distributor.publicKey
    );

    const to = await getOrCreateAssociatedTokenAccount(
      connection,
      distributor,
      MINT,
      buyerPk
    );

    const tokenTx = await transferChecked(
      connection,
      distributor,
      from.address,
      MINT,
      to.address,
      distributor,
      amountToSend,
      DECIMALS
    );

    processedTransactions.add(signature);

    const saleRecord = {
      buyer: buyerPk.toBase58(),
      buyerMasked: maskWallet(buyerPk.toBase58()),
      paymentSignature: signature,
      tokenSignature: tokenTx,
      solAmount: Number(solAmount.toFixed(6)),
      usdValue: Number(usdValue.toFixed(2)),
      tokens: Number(tokens.toFixed(2)),
      timestamp: new Date().toISOString()
    };

    addSale(saleRecord);

    console.log("✅ TOKENS SENT:", tokenTx);

    return {
      success: true,
      paymentSignature: signature,
      tokenSignature: tokenTx,
      solAmount: saleRecord.solAmount,
      solPrice: FIXED_SOL_PRICE,
      usdValue: saleRecord.usdValue,
      tokens: saleRecord.tokens
    };
  } finally {
    inProgressTransactions.delete(signature);
  }
}

// --------------------------
// Routes
// --------------------------
app.get("/", (_req, res) => {
  res.json({ ok: true, message: "CARDIX backend running" });
});

app.get("/stats", (_req, res) => {
  res.json(getStats());
});

app.post("/create-transaction", rateLimit, async (req, res) => {
  try {
    const { buyer, amount } = req.body;
    const ip = getClientIp(req);

    if (!buyer || amount === undefined || amount === null) {
      return res.status(400).json({
        error: "buyer and amount are required"
      });
    }

    const solAmount = Number(amount);

    if (!Number.isFinite(solAmount) || solAmount <= 0) {
      return res.status(400).json({
        error: "Invalid SOL amount"
      });
    }

    if (solAmount < MIN_SOL_AMOUNT) {
      return res.status(400).json({
        error: `Minimum purchase is ${MIN_SOL_AMOUNT} SOL`
      });
    }

    if (solAmount > MAX_SOL_AMOUNT) {
      return res.status(400).json({
        error: `Maximum purchase per transaction is ${MAX_SOL_AMOUNT} SOL`
      });
    }

    if (blockDuplicateCreateRequest(ip, buyer, solAmount)) {
      return res.status(429).json({
        error: "Duplicate request detected. Please wait a few seconds."
      });
    }

    const buyerPk = new PublicKey(buyer);
    const latest = await connection.getLatestBlockhash("confirmed");

    const tx = new Transaction({
      feePayer: buyerPk,
      recentBlockhash: latest.blockhash
    }).add(
      SystemProgram.transfer({
        fromPubkey: buyerPk,
        toPubkey: TREASURY,
        lamports: Math.round(solAmount * LAMPORTS_PER_SOL)
      })
    );

    const serialized = tx.serialize({
      requireAllSignatures: false,
      verifySignatures: false
    });

    return res.json({
      success: true,
      transaction: serialized.toString("base64"),
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight
    });
  } catch (e) {
    console.error("❌ CREATE TRANSACTION ERROR:", e.message);
    return res.status(500).json({
      error: e.message
    });
  }
});

app.post("/submit-signed-transaction", rateLimit, async (req, res) => {
  try {
    const { signedTransaction, buyer } = req.body;

    if (!signedTransaction || !buyer) {
      return res.status(400).json({
        error: "signedTransaction and buyer are required"
      });
    }

    const rawTx = Buffer.from(signedTransaction, "base64");

    const signature = await connection.sendRawTransaction(rawTx, {
      skipPreflight: false,
      preflightCommitment: "confirmed"
    });

    console.log("📨 Signed transaction submitted:", signature);

    const txInfo = await connection.getLatestBlockhash("confirmed");

    await connection.confirmTransaction(
      {
        signature,
        blockhash: txInfo.blockhash,
        lastValidBlockHeight: txInfo.lastValidBlockHeight
      },
      "confirmed"
    );

    const result = await processPurchase(signature, buyer);
    return res.json(result);
  } catch (e) {
    console.error("❌ SUBMIT SIGNED TRANSACTION ERROR:", e.message);
    return res.status(500).json({
      error: e.message
    });
  }
});

// Legacy endpoint
app.post("/buy", rateLimit, async (req, res) => {
  try {
    const { signature, buyer } = req.body;

    if (!signature || !buyer) {
      return res.status(400).json({
        error: "signature and buyer are required"
      });
    }

    const result = await processPurchase(signature, buyer);
    return res.json(result);
  } catch (e) {
    console.error("❌ BUY ERROR:", e.message);
    return res.status(500).json({
      error: e.message
    });
  }
});

app.listen(process.env.PORT || 10000, () => {
  console.log("🚀 CARDIX backend running");
});
