require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function checkOrders() {
  try {
    console.log("Controllo ordini BNB...");

    const { data, error } = await supabase
      .from('presale_orders')
      .select('*')
      .eq('payment_chain', 'BNB')
      .eq('status', 'pending');

    if (error) {
      console.error("Errore lettura ordini:", error.message);
      return;
    }

    if (!data || data.length === 0) {
      console.log("Nessun ordine pending su BNB");
      return;
    }

    console.log(`Trovati ${data.length} ordini da controllare`);

  } catch (err) {
    console.error("Errore generale:", err.message);
  }
}

console.log("BNB watcher attivo...");

setInterval(checkOrders, 15000);
