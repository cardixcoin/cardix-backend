const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Mancano SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY nelle environment variables.');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// ROUTE BASE
app.get('/', (req, res) => {
  res.send('Il backend CARDIX con Supabase è in esecuzione 🚀');
});

// HEALTH CHECK
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// REGISTRAZIONE WALLET
app.post('/register', async (req, res) => {
  try {
    const { wallet } = req.body;

    if (!wallet || typeof wallet !== 'string' || wallet.trim() === '') {
      return res.status(400).json({
        success: false,
        error: 'Wallet mancante o non valido'
      });
    }

    const cleanWallet = wallet.trim();

    const { error } = await supabase
      .from('investors')
      .upsert(
        {
          wallet_address: cleanWallet
        },
        {
          onConflict: 'wallet_address'
        }
      );

    if (error) {
      console.error('Errore Supabase /register:', error.message);
      return res.status(500).json({
        success: false,
        error: error.message
      });
    }

    return res.json({
      success: true,
      wallet: cleanWallet
    });
  } catch (err) {
    console.error('Errore server /register:', err.message);
    return res.status(500).json({
      success: false,
      error: 'Errore interno del server'
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server CARDIX attivo sulla porta ${PORT}`);
});
