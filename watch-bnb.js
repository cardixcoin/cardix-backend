const { ethers } = require('ethers');
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const rpcUrl = process.env.BNB_RPC_URL;

if (!supabaseUrl || !supabaseKey || !rpcUrl) {
  console.error('Mancano SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY o BNB_RPC_URL');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false
  }
});

const provider = new ethers.JsonRpcProvider(rpcUrl);

const USDT_ADDRESS = '0x55d398326f99059ff775485246999027b3197955';

const ABI = [
  'event Transfer(address indexed from, address indexed to, uint256 value)'
];

const contract = new ethers.Contract(USDT_ADDRESS, ABI, provider);

console.log('🚀 BNB watcher attivo...');

async function checkTransfers() {
  try {
    const { data: orders, error } = await supabase
      .schema('public')
      .from('presale_orders')
      .select('*')
      .eq('status', 'pending')
      .eq('payment_chain', 'BNB');

    if (error) {
      console.error('Errore lettura ordini:', error.message);
      return;
    }

    if (!orders || orders.length === 0) {
      console.log('Nessun ordine pending su BNB');
      return;
    }

    const latestBlock = await provider.getBlockNumber();
    const fromBlock = Math.max(latestBlock - 2000, 1);

    const logs = await provider.getLogs({
      address: USDT_ADDRESS,
      fromBlock,
      toBlock: latestBlock
    });

    for (const log of logs) {
      let parsed;

      try {
        parsed = contract.interface.parseLog(log);
      } catch {
        continue;
      }

      const from = parsed.args.from.toLowerCase();
      const to = parsed.args.to.toLowerCase();
      const amount = Number(ethers.formatUnits(parsed.args.value, 18));

      for (const order of orders) {
        if (!order.to_wallet) continue;

        const sameWallet = order.to_wallet.toLowerCase() === to;
        const sameAmount =
          Math.abs(Number(order.expected_amount) - amount) < 0.0001;
        const noTxYet = !order.tx_hash;

        if (sameWallet && sameAmount && noTxYet) {
          console.log('💰 Pagamento trovato per ordine:', order.order_id);

          const { error: updateError } = await supabase
            .schema('public')
            .from('presale_orders')
            .update({
              status: 'confirmed',
              amount_paid: amount,
              tx_hash: log.transactionHash,
              from_wallet: from
            })
            .eq('id', order.id);

          if (updateError) {
            console.error('Errore update ordine:', updateError.message);
          } else {
            console.log('✅ Ordine aggiornato:', order.order_id);
          }
        }
      }
    }
  } catch (err) {
    console.error('Errore watcher BNB:', err.message);
  }
}

checkTransfers();
setInterval(checkTransfers, 15000);
