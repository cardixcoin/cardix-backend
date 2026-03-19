const { Connection, PublicKey } = require('@solana/web3.js');
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const solanaRpcUrl = process.env.SOLANA_RPC_URL;

if (!supabaseUrl || !supabaseKey || !solanaRpcUrl) {
  console.error('Mancano SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY o SOLANA_RPC_URL');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false
  }
});

const connection = new Connection(solanaRpcUrl, 'confirmed');

// USDT mint su Solana
const USDT_SOLANA_MINT = 'Es9vMFrzaCERmJfrF4H2FYDutLCRa14Q6gttxyPjdvVS';

console.log('🚀 SOLANA watcher attivo...');

async function checkSolanaTransfers() {
  try {
    const { data: orders, error } = await supabase
      .schema('public')
      .from('presale_orders')
      .select('*')
      .eq('status', 'pending')
      .eq('payment_chain', 'SOLANA');

    if (error) {
      console.error('Errore lettura ordini SOLANA:', error.message);
      return;
    }

    if (!orders || orders.length === 0) {
      console.log('Nessun ordine pending su SOLANA');
      return;
    }

    for (const order of orders) {
      if (!order.to_wallet) continue;

      const targetWallet = order.to_wallet;
      const expectedAmount = Number(order.expected_amount);

      const pubkey = new PublicKey(targetWallet);

      const signatures = await connection.getSignaturesForAddress(pubkey, {
        limit: 30
      });

      for (const sig of signatures) {
        const tx = await connection.getParsedTransaction(sig.signature, {
          maxSupportedTransactionVersion: 0
        });

        if (!tx || !tx.meta || !tx.transaction) continue;

        const txHash = sig.signature;

        let foundMatch = false;
        let fromWallet = null;
        let amountPaid = 0;

        const instructions = tx.transaction.message.instructions || [];

        for (const ix of instructions) {
          if (!ix.parsed) continue;

          const parsed = ix.parsed;
          const info = parsed.info || {};

          // Cerchiamo transfer di token SPL
          if (
            parsed.type === 'transferChecked' ||
            parsed.type === 'transfer'
          ) {
            const mint = info.mint || info.tokenMint || null;

            if (mint && mint !== USDT_SOLANA_MINT) continue;

            const destination = info.destination || info.account || null;
            const authority = info.authority || info.source || null;

            let rawAmount = 0;

            if (info.tokenAmount && info.tokenAmount.uiAmount != null) {
              rawAmount = Number(info.tokenAmount.uiAmount);
            } else if (info.amount) {
              // fallback semplice per USDT Solana 6 decimali
              rawAmount = Number(info.amount) / 1_000_000;
            }

            if (
              destination &&
              String(destination).trim() === String(targetWallet).trim() &&
              Math.abs(rawAmount - expectedAmount) < 0.000001
            ) {
              foundMatch = true;
              fromWallet = authority || null;
              amountPaid = rawAmount;
              break;
            }
          }
        }

        if (foundMatch && !order.tx_hash) {
          console.log('💰 Pagamento SOLANA trovato per ordine:', order.order_id);

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
            console.error('Errore update ordine SOLANA:', updateError.message);
          } else {
            console.log('✅ Ordine SOLANA aggiornato:', order.order_id);
          }
        }
      }
    }
  } catch (err) {
    console.error('Errore watcher SOLANA:', err.message);
  }
}

checkSolanaTransfers();
setInterval(checkSolanaTransfers, 15000);
