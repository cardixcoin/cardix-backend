const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

app.get("/", (req, res) => {
  res.send("CARDIX backend with Supabase is running 🚀");
});

app.post("/buy", async (req, res) => {
  try {
    const { wallet, amount_usdt, cdx_amount, tx_signature } = req.body;

    if (!wallet || !amount_usdt || !cdx_amount || !tx_signature) {
      return res.status(400).json({ error: "Missing data" });
    }

    const { data: investor } = await supabase
      .from("investors")
      .select("*")
      .eq("wallet_address", wallet)
      .maybeSingle();

    if (!investor) {
      await supabase.from("investors").insert({
        wallet_address: wallet,
        total_balance: cdx_amount,
        claimed_balance: 0
      });
    } else {
      await supabase.from("investors").update({
        total_balance: Number(investor.total_balance) + Number(cdx_amount)
      }).eq("wallet_address", wallet);
    }

    await supabase.from("orders").insert({
      wallet_address: wallet,
      tx_signature,
      amount_usdt,
      cdx_amount
    });

    res.json({ success: true });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
