const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;
const PRICE_PER_CARDIX = 0.0001; // 1 CARDIX = 0.0001 USDT

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Mancano SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY nelle environment variables.');
  process.exit(1);
}

console.log('SUPABASE_URL presente:', !!supabaseUrl);
console.log('SUPABASE_SERVICE_ROLE_KEY presente:', !!supabaseKey);

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false
  }
});

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

function handleSupabaseError(context, error, res) {
  console.error(`Errore Supabase ${context}:`, {
    message: error?.message || null,
    code: error?.code || null,
    details: error?.details || null,
    hint: error?.hint || null
  });

  return res.status(500).json({
    success: false,
    error: error?.message || 'Errore database'
  });
}

// ROUTE BASE
app.get('/', (req, res) => {
  res.send('Il backend CARDIX con Supabase è in esecuzione 🚀');
});

// HEALTH CHECK
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// TEST PAYMENT WALLETS
app.get('/test-payment-wallets', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('payment_wallets')
      .select('chain, wallet_address, token_symbol, is_active')
      .limit(10);

    if (error) {
      return handleSupabaseError('/test-payment-wallets', error, res);
    }

    return res.json({
      success: true,
      rows: data
    });
  } catch (err) {
    console.error('Errore server /test-payment-wallets:', err.message);
    return res.status(500).json({
      success: false,
      error: 'Errore interno del server'
    });
  }
});

// REGISTRA WALLET
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
      return handleSupabaseError('/register', error, res);
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

// RESTITUISCE IL WALLET UFFICIALE
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
      .single();

    if (error) {
      return handleSupabaseError('/payment-wallet', error, res);
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

// CREA ORDINE PREVENDITA
app.post('/create-order', async (req, res) => {
  try {
    const {
      wallet,
      payment_chain,
      expected_amount,
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

    if (Number.isNaN(expectedAmountNumber) || expectedAmountNumber <= 0) {
      return res.status(400).json({
        success: false,
        error: 'expected_amount non valido'
      });
    }

    const cardixAmountNumber = Number(
      (expectedAmountNumber / PRICE_PER_CARDIX).toFixed(2)
    );

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
      return handleSupabaseError('investor upsert', investorError, res);
    }

    // prende wallet corretto per rete
    const { data: paymentWallet, error: walletError } = await supabase
      .from('payment_wallets')
      .select('chain, wallet_address, token_symbol, is_active')
      .eq('chain', normalizedChain)
      .eq('is_active', true)
      .single();

    if (walletError) {
      return handleSupabaseError('payment_wallets select', walletError, res);
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
      return handleSupabaseError('/create-order', error, res);
    }

    return res.json({
      success: true,
      order: data,
      pricing: {
        price_per_cardix_usdt: PRICE_PER_CARDIX
      },
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
      return handleSupabaseError('/orders', error, res);
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
