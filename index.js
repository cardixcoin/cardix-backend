const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
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

function normalizeChain(chain) {
  if (!chain || typeof chain !== 'string') return null;

  const value = chain.trim().toUpperCase();

  if (value === 'BNB' || value === 'BSC' || value === 'BEP20') return 'BNB';
  if (value === 'TRON' || value === 'TRC20') return 'TRON';
  if (value === 'SOLANA' || value === 'SPL') return 'SOLANA';

  return null;
}

function generateOrderId() {
  return `CRDX-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

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

// RESTITUISCE IL WALLET UFFICIALE IN BASE ALLA RETE
app.get('/payment-wallet/:chain', async (req, res) => {
  try {
    const normalizedChain = normalizeChain(req.params.chain);

    if (!normalizedChain) {
      return res.status(400).json({
        success: false,
        error: 'Rete non valida. Usa BNB, TRON o SOLANA'
      });
    }

    const { data, error } = await supabase
      .from('payment_wallets')
      .select('chain, wallet_address, token_symbol, is_active')
      .eq('chain', normalizedChain)
      .eq('is_active', true)
      .maybeSingle();

    if (error) {
      console.error('Errore Supabase /payment-wallet:', error.message);
      return res.status(500).json({
        success: false,
        error: error.message
      });
    }

    if (!data) {
      return res.status(404).json({
        success: false,
        error: 'Wallet di pagamento non trovato per questa rete'
      });
    }

    return res.json({
      success: true,
      payment_wallet: data
    });
  } catch (err) {
    console.error('Errore server /payment-wallet:', err.message);
    return res.status(500).json({
      success: false,
      error: 'Errore interno del server'
    });
  }
});

// CREA ORDINE PREVENDITA PENDING
app.post('/create-order', async (req, res) => {
  try {
    const {
      wallet,
      payment_chain,
      expected_amount,
      cardix_amount,
      notes
    } = req.body;

    if (!wallet || typeof wallet !== 'string' || wallet.trim() === '') {
      return res.status(400).json({
        success: false,
        error: 'Wallet mancante o non valido'
      });
    }

    const normalizedChain = normalizeChain(payment_chain);

    if (!normalizedChain) {
      return res.status(400).json({
        success: false,
        error: 'payment_chain non valida. Usa BNB, TRON o SOLANA'
      });
    }

    const expectedAmountNumber = Number(expected_amount);
    const cardixAmountNumber = Number(cardix_amount);

    if (Number.isNaN(expectedAmountNumber) || expectedAmountNumber <= 0) {
      return res.status(400).json({
        success: false,
        error: 'expected_amount non valido'
      });
    }

    if (Number.isNaN(cardixAmountNumber) || cardixAmountNumber <= 0) {
      return res.status(400).json({
        success: false,
        error: 'cardix_amount non valido'
      });
    }

    const cleanWallet = wallet.trim();
    const cleanNotes =
      notes && typeof notes === 'string' ? notes.trim() : null;

    // assicura investitore
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

    // prende il wallet corretto per la rete scelta
    const { data: paymentWallet, error: walletError } = await supabase
      .from('payment_wallets')
      .select('chain, wallet_address, token_symbol, is_active')
      .eq('chain', normalizedChain)
      .eq('is_active', true)
      .maybeSingle();

    if (walletError) {
      console.error('Errore Supabase payment_wallets:', walletError.message);
      return res.status(500).json({
        success: false,
        error: walletError.message
      });
    }

    if (!paymentWallet) {
      return res.status(404).json({
        success: false,
        error: 'Wallet di pagamento non configurato per questa rete'
      });
    }

    const orderId = generateOrderId();

    const insertPayload = {
      order_id: orderId,
      wallet_address: cleanWallet,
      payment_chain: normalizedChain,
      payment_token: 'USDT',
      to_wallet: paymentWallet.wallet_address,
      expected_amount: expectedAmountNumber,
      amount_paid: 0,
      cardix_amount: cardixAmountNumber,
      status: 'pending',
      notes: cleanNotes
    };

    const { data, error } = await supabase
      .from('presale_orders')
      .insert([insertPayload])
      .select()
      .single();

    if (error) {
      console.error('Errore Supabase /create-order:', error.message);
      return res.status(500).json({
        success: false,
        error: error.message
      });
    }

    return res.json({
      success: true,
      order: data,
      payment_instructions: {
        chain: normalizedChain,
        token: 'USDT',
        wallet_address: paymentWallet.wallet_address,
        amount_to_send: expectedAmountNumber
      }
    });
  } catch (err) {
    console.error('Errore server /create-order:', err.message);
    return res.status(500).json({
      success: false,
      error: 'Errore interno del server'
    });
  }
});

// ORDINI PER WALLET
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
