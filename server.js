import "dotenv/config";
import express from "express";
import cors from "cors";
import bs58 from "bs58";
import {
  Connection,
  PublicKey,
  Keypair,
  LAMPORTS_PER_SOL,
  Transaction,
  SystemProgram
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
const PRICE = Number(process.env.CARDIX_PRICE_USD);   // 0.0001
const DECIMALS = Number(process.env.CARDIX_DECIMALS); // 6
const FIXED_SOL_PRICE = 80; // 1 SOL = 80 USD

const processedTransactions = new Set();

app.get("/", (_req, res) => {
  res.json({ ok: true, message: "CARDIX backend running" });
});

/**
 * PRO FLOW - STEP 1
 * Create unsigned transaction server-side
 */
app.post("/create-transaction", async (req, res) => {
  try {
    const { buyer, amount } = req.body;

    if (!buyer || !amount) {
      return res.status(400).json({
        error: "buyer and amount are required"
      });
    }

    const solAmount = Number(amount);

    if (!solAmount || solAmount <= 0) {
      return res.status(400).json({
        error: "Invalid SOL amount"
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

/**
 * Internal helper: distribute CARDIX after confirmed payment
 */
async function processPurchase(signature, buyer) {
  if (processedTransactions.has(signature)) {
    throw new Error("Transaction already processed");
  }

  const tx = await connection.getTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0
  });

  if (!tx) throw new Error("Transaction not found");
  if (tx.meta?.err) throw new Error("Transaction failed");

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
    throw new Error("No SOL received");
  }

  const solAmount = receivedLamports / LAMPORTS_PER_SOL;
  const usdValue = solAmount * FIXED_SOL_PRICE;
  const tokens = usdValue / PRICE;
  const amountToSend = BigInt(Math.floor(tokens * 10 ** DECIMALS));

  if (amountToSend <= 0n) {
    throw new Error("Token amount is zero");
  }

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

  console.log("✅ TOKENS SENT:", tokenTx);

  return {
    success: true,
    paymentSignature: signature,
    tokenSignature: tokenTx,
    solAmount,
    solPrice: FIXED_SOL_PRICE,
    usdValue,
    tokens
  };
}

/**
 * PRO FLOW - STEP 2
 * Receive signed transaction from frontend, send it, confirm it, distribute CARDIX
 */
app.post("/submit-signed-transaction", async (req, res) => {
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

    const latest = await connection.getLatestBlockhash("confirmed");

    await connection.confirmTransaction(
      {
        signature,
        blockhash: latest.blockhash,
        lastValidBlockHeight: latest.lastValidBlockHeight
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

/**
 * LEGACY FLOW
 * Keep old endpoint if needed
 */
app.post("/buy", async (req, res) => {
  try {
    const { signature, buyer } = req.body;

    console.log("📩 Incoming request:", signature, buyer);

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
