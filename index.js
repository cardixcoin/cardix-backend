const express = require("express");
const cors = require("cors");
require("dotenv").config();

const app = express();

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("CARDIX backend is running 🚀");
});

app.post("/buy", async (req, res) => {
  const { wallet, amount } = req.body;

  if (!wallet || !amount) {
    return res.status(400).json({ error: "Missing data" });
  }

  console.log("New BUY request:", wallet, amount);

  return res.json({
    success: true,
    message: "Transaction received",
  });
});

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
