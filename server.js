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

const connection = new Connection(process.env.RPC_URL);

const distributor = Keypair.fromSecretKey(
  bs58.decode(process.env.DISTRIBUTOR_PRIVATE_KEY)
);

const MINT = new PublicKey(process.env.CARDIX_MINT);
const PRICE = Number(process.env.CARDIX_PRICE_USD);
const DECIMALS = Number(process.env.CARDIX_DECIMALS);

async function getSolPrice() {
  const res = await axios.get("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd");
  return res.data.solana.usd;
}

app.post("/buy", async (req, res) => {
  try {
    const { signature, buyer } = req.body;

    const tx = await connection.getTransaction(signature, { commitment: "confirmed" });
    if (!tx) throw new Error("Transaction not found");

    const solReceived = tx.meta.postBalances[1] - tx.meta.preBalances[1];
    const solAmount = solReceived / LAMPORTS_PER_SOL;

    const solPrice = await getSolPrice();
    const usdValue = solAmount * solPrice;

    const tokens = usdValue / PRICE;
    const amount = BigInt(Math.floor(tokens * 10 ** DECIMALS));

    const buyerPk = new PublicKey(buyer);

    const from = await getOrCreateAssociatedTokenAccount(connection, distributor, MINT, distributor.publicKey);
    const to = await getOrCreateAssociatedTokenAccount(connection, distributor, MINT, buyerPk);

    const sig = await transferChecked(
      connection,
      distributor,
      from.address,
      MINT,
      to.address,
      distributor,
      amount,
      DECIMALS
    );

    res.json({ success: true, tokens });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(process.env.PORT, () => console.log("CARDIX backend running"));
