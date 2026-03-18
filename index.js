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
        [{ wallet_address: cleanWallet }],
        { onConflict: 'wallet_address' }
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

// CREAZIONE ORDINE PREVENDITA
app.post('/create-order', async (req, res) => {
  try {
    const { wallet, payment_token, amount_paid, cardix_amount } = req.body;

    if (!wallet || typeof wallet !== 'string' || wallet.trim() === '') {
      return res.status(400).json({
        success: false,
        error: 'Wallet mancante o non valido'
      });
    }

    if (!payment_token || typeof payment_token !== 'string' || payment_token.trim() === '') {
      return res.status(400).json({
        success: false,
        error: 'payment_token mancante o non valido'
      });
    }

    const paid = Number(amount_paid);
    const cardix = Number(cardix_amount);

    if (Number.isNaN(paid) || paid <= 0) {
      return res.status(400).json({
        success: false,
        error: 'amount_paid non valido'
      });
    }

    if (Number.isNaN(cardix) || cardix <= 0) {
      return res.status(400).json({
        success: false,
        error: 'cardix_amount non valido'
      });
    }

    const cleanWallet = wallet.trim();
    const cleanPaymentToken = payment_token.trim().toUpperCase();

    // assicura che l'investitore esista
    const { error: investorError } = await supabase
      .from('investors')
      .upsert(
        [{ wallet_address: cleanWallet }],
        { onConflict: 'wallet_address' }
      );

    if (investorError) {
      console.error('Errore Supabase investor upsert:', investorError.message);
      return res.status(500).json({
        success: false,
        error: investorError.message
      });
    }

    // crea l'ordine
    const { data, error } = await supabase
      .from('presale_orders')
      .insert([
        {
          wallet_address: cleanWallet,
          payment_token: cleanPaymentToken,
          amount_paid: paid,
          cardix_amount: cardix,
          status: 'pending'
        }
      ])
      .select();

    if (error) {
      console.error('Errore Supabase /create-order:', error.message);
      return res.status(500).json({
        success: false,
        error: error.message
      });
    }

    return res.json({
      success: true,
      order: data[0]
    });
  } catch (err) {
    console.error('Errore server /create-order:', err.message);
    return res.status(500).json({
      success: false,
      error: 'Errore interno del server'
    });
  }
});

// RECUPERA ORDINI DI UN WALLET
app.get('/orders/:wallet', async (req, res) => {
  try {
    const wallet = req.params.wallet;

    if (!wallet || typeof wallet !== 'string' || wallet.trim() === '') {
      return res.status(400).json({
        success: false,
        error: 'Wallet mancante o non valido'
      });
    }

    const cleanWallet = wallet.trim();

    const { data, error } = await supabase
      .from('presale_orders')
      .select('*')
      .eq('wallet_address', cleanWallet)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Errore Supabase /orders:', error.message);
      return res.status(500).json({
        success: false,
        error: error.message
      });
    }

    return res.json({
      success: true,
      wallet: cleanWallet,
      orders: data
    });
  } catch (err) {
    console.error('Errore server /orders:', err.message);
    return res.status(500).json({
      success: false,
      error: 'Errore interno del server'
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server CARDIX attivo sulla porta ${PORT}`);
});
