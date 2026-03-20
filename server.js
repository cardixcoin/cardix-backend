import "dotenv/config";
import express from "express";
import cors from "cors";
import axios from "axios";
import bs58 from "bs58";
import {
  Connection,
  PublicKey,
  Keypair,
  LAMPORTS_PER_SOL
} from "@solana/web3.js";
import {
  getOrCreateAssociatedTokenAccount,
  transferChecked
} from "@solana/spl-token";

const app = express();
app.use(cors());
app.use(express.json());

/* ================= ENV CHECK ================= */

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

/* ================= CONNECTION ================= */

const connection = new Connection(process.env.RPC_URL, "confirmed");

/* ================= WALLET ================= */

let distributor;

try {
  const privateKey = process.env.DISTRIBUTOR_PRIVATE_KEY.trim();
  distributor = Keypair.fromSecretKey(bs58.decode(privateKey));

  console.log("✅ Distributor wallet:", distributor.publicKey.toBase58());
} catch (err) {
  console.error("❌ INVALID PRIVATE KEY");
  throw err;
}

/* ================= CONFIG ================= */

const MINT = new PublicKey(process.env.CARDIX_MINT);
const TREASURY = new PublicKey(process.env.TREASURY_WALLET);
const PRICE = Number(process.env.CARDIX_PRICE_USD);
const DECIMALS = Number(process.env.CARDIX_DECIMALS);

const processedTransactions = new Set();

/* ================= SOL PRICE ================= */

async function getSolPrice() {
  const res = await axios.get(
    "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd"
  );
  return res.data.solana.usd;
}

/* ================= ROUTES ================= */

app.get("/", (_req, res) => {
  res.json({ ok: true, message: "CARDIX backend running" });
});

/* ================= BUY ================= */

app.post("/buy", async (req, res) => {
  try {
    const { signature, buyer } = req.body;

    console.log("📩 Incoming request:", signature, buyer);

    if (!signature || !buyer) {
      return res.status(400).json({
        error: "signature and buyer are required"
      });
    }

    if (processedTransactions.has(signature)) {
      return res.status(400).json({
        error: "Transaction already processed"
      });
    }

    const tx = await connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0
    });

    if (!tx) throw new Error("Transaction not found");
    if (tx.meta?.err) throw new Error("Transaction failed");

    const buyerPk = new PublicKey(buyer);

    const accountKeys =
      tx.transaction.message.getAccountKeys().staticAccountKeys;

    const buyerIndex = accountKeys.findIndex((k) =>
      k.equals(buyerPk)
    );
    const treasuryIndex = accountKeys.findIndex((k) =>
      k.equals(TREASURY)
    );

    if (buyerIndex === -1)
      throw new Error("Buyer wallet not found in transaction");

    if (treasuryIndex === -1)
      throw new Error("Treasury wallet not found");

    const preBalances = tx.meta.preBalances;
    const postBalances = tx.meta.postBalances;

    const receivedLamports =
      postBalances[treasuryIndex] - preBalances[treasuryIndex];

    if (receivedLamports <= 0)
      throw new Error("No SOL received");

    const solAmount = receivedLamports / LAMPORTS_PER_SOL;

    console.log("💰 SOL received:", solAmount);

    const solPrice = await getSolPrice();
    const usdValue = solAmount * solPrice;

    console.log("💵 USD value:", usdValue);

    const tokens = usdValue / PRICE;

    const amount = BigInt(
      Math.floor(tokens * 10 ** DECIMALS)
    );

    if (amount <= 0)
      throw new Error("Token amount is zero");

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
      amount,
      DECIMALS
    );

    processedTransactions.add(signature);

    console.log("✅ TOKENS SENT:", tokenTx);

    res.json({
      success: true,
      paymentSignature: signature,
      tokenSignature: tokenTx,
      solAmount,
      solPrice,
      usdValue,
      tokens
    });
  } catch (e) {
    console.error("❌ BUY ERROR:", e.message);

    res.status(500).json({
      error: e.message
    });
  }
});

/* ================= SERVER ================= */

app.listen(process.env.PORT || 10000, () => {
  console.log("🚀 CARDIX backend running");
});
