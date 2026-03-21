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
app.use(express.json());

const connection = new Connection(process.env.RPC_URL, "confirmed");

const distributor = Keypair.fromSecretKey(
  bs58.decode(process.env.DISTRIBUTOR_PRIVATE_KEY)
);

const MINT = new PublicKey(process.env.CARDIX_MINT);
const TREASURY = new PublicKey(process.env.TREASURY_WALLET);
const PRICE = Number(process.env.CARDIX_PRICE_USD);
const DECIMALS = Number(process.env.CARDIX_DECIMALS);
const FIXED_SOL_PRICE = 80;

// ✅ HEALTH CHECK
app.get("/", (_req, res) => {
  res.json({ ok: true, message: "CARDIX backend running" });
});


// 🔥 STEP 1 → CREA TRANSAZIONE
app.post("/create-transaction", async (req, res) => {
  try {
    const { buyer, amount } = req.body;

    const buyerPk = new PublicKey(buyer);

    const { blockhash } = await connection.getLatestBlockhash();

    const tx = new Transaction({
      feePayer: buyerPk,
      recentBlockhash: blockhash
    }).add(
      SystemProgram.transfer({
        fromPubkey: buyerPk,
        toPubkey: TREASURY,
        lamports: Math.round(amount * LAMPORTS_PER_SOL)
      })
    );

    const serialized = tx.serialize({
      requireAllSignatures: false
    });

    const base64 = Buffer.from(serialized).toString("base64");

    res.json({
      success: true,
      transaction: base64
    });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// 🔥 STEP 2 → INVIO + TOKEN
app.post("/submit-signed-transaction", async (req, res) => {
  try {
    const { signedTransaction, buyer } = req.body;

    const txBuffer = Buffer.from(signedTransaction, "base64");

    const signature = await connection.sendRawTransaction(txBuffer);

    await connection.confirmTransaction(signature, "confirmed");

    // CALCOLO TOKEN
    const solAmount = 1; // puoi migliorarlo leggendo tx reale
    const usdValue = solAmount * FIXED_SOL_PRICE;
    const tokens = usdValue / PRICE;

    const amount = BigInt(Math.floor(tokens * 10 ** DECIMALS));

    const buyerPk = new PublicKey(buyer);

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

    res.json({
      success: true,
      paymentSignature: signature,
      tokenSignature: tokenTx,
      tokens
    });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(process.env.PORT || 10000, () => {
  console.log("🚀 CARDIX backend running");
});
