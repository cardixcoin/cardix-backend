const TronWeb = require('tronweb');
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const tronRpcUrl = process.env.TRON_RPC_URL;

if (!supabaseUrl || !supabaseKey || !tronRpcUrl) {
  console.error('Mancano SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY o TRON_RPC_URL');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false
  }
});

const tronWeb = new TronWeb({
  fullHost: tronRpcUrl
});

// USDT TRC20
const USDT_TRON_CONTRACT = 'TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj';

console.log('🚀 TRON watcher attivo...');

async function checkTronTransfers() {
  try {
    const { data: orders, error } = await supabase
      .schema('public')
      .from('presale_orders')
      .select('*')
      .eq('status', 'pending')
      .eq('payment_chain', 'TRON');

    if (error) {
      console.error('Errore lettura ordini TRON:', error.message);
      return;
    }

    if (!orders || orders.length === 0) {
      console.log('Nessun ordine pending su TRON');
      return;
    }

    const contract = await tronWeb.contract().at(USDT_TRON_CONTRACT);

    for (const order of orders) {
      if (!order.to_wallet) continue;

      const targetWallet = order.to_wallet;
      const expectedAmount = Number(order.expected_amount);

      // TronGrid-style TRC20 transfer query
      const url = `${tronRpcUrl}/v1/accounts/${targetWallet}/transactions/trc20?limit=50&contract_address=${USDT_TRON_CONTRACT}`;

      const response = await fetch(url);
      const result = await response.json();

      if (!result.data || !Array.isArray(result.data)) continue;

      for (const tx of result.data) {
        const fromWallet = tx.from;
        const toWallet = tx.to;
        const txHash = tx.transaction_id;

        // USDT TRON usa 6 decimali
        const amountPaid = Number(tx.value) / 1_000_000;

        const sameWallet = String(toWallet).trim() === String(targetWallet).trim();
        const sameAmount = Math.abs(amountPaid - expectedAmount) < 0.000001;
        const noTxYet = !order.tx_hash;

        if (sameWallet && sameAmount && noTxYet) {
          console.log('💰 Pagamento TRON trovato per ordine:', order.order_id);

          const { error: updateError } = await supabase
            .schema('public')
            .from('presale_orders')
            .update({
              status: 'confirmed',
              amount_paid: amountPaid,
              tx_hash: txHash,
              from_wallet: fromWallet
            })
            .eq('id', order.id);

          if (updateError) {
            console.error('Errore update ordine TRON:', updateError.message);
          } else {
            console.log('✅ Ordine TRON aggiornato:', order.order_id);
          }
        }
      }
    }
  } catch (err) {
    console.error('Errore watcher TRON:', err.message);
  }
}

checkTronTransfers();
setInterval(checkTronTransfers, 15000);
