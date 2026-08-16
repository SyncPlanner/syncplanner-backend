const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { Redis } = require('@upstash/redis');

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if(req.method === 'OPTIONS') return res.status(200).end();

  const url = req.url || '';

  // GET /verify/:email
  if(req.method === 'GET' && url.includes('/verify/')) {
    const email = decodeURIComponent(url.split('/verify/')[1]).toLowerCase();
    const licence = await redis.get(`licence:${email}`);
    if(licence && licence.status === 'active') {
      return res.json({ valid: true, plan: licence.plan, expires: licence.expires });
    }
    return res.json({ valid: false });
  }

  // POST /create-checkout
  if(req.method === 'POST' && url.includes('/create-checkout')) {
    const body = await getBody(req);
    const { email, plan } = JSON.parse(body);
    const prices = {
      monthly:  process.env.PRICE_MONTHLY,
      yearly:   process.env.PRICE_YEARLY,
      lifetime: process.env.PRICE_LIFETIME,
    };
    try {
      const session = await stripe.checkout.sessions.create({
        mode: plan === 'lifetime' ? 'payment' : 'subscription',
        customer_email: email,
        line_items: [{ price: prices[plan]||prices.monthly, quantity: 1 }],
        success_url: 'https://syncplanner-backend.vercel.app/success',
        cancel_url:  'https://syncplanner-backend.vercel.app/cancel',
      });
      return res.json({ url: session.url });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // POST /create-portal
  if(req.method === 'POST' && url.includes('/create-portal')) {
    const body = await getBody(req);
    const { email } = JSON.parse(body);
    try {
      const customers = await stripe.customers.list({ email: email.toLowerCase(), limit: 1 });
      if(!customers.data.length) {
        return res.status(404).json({ error: 'Customer not found' });
      }
      const session = await stripe.billingPortal.sessions.create({
        customer: customers.data[0].id,
        return_url: 'https://syncplanner.app',
      });
      return res.json({ url: session.url });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // POST /webhook
  if(req.method === 'POST' && url.includes('/webhook')) {
    const rawBody = await getBody(req);
    try {
      const event = stripe.webhooks.constructEvent(
        rawBody,
        req.headers['stripe-signature'],
        process.env.STRIPE_WEBHOOK_SECRET
      );
      if(event.type === 'checkout.session.completed') {
        const s = event.data.object;
        const email = s.customer_email?.toLowerCase();
        if(email) {
          await redis.set(`licence:${email}`, {
            status: 'active',
            plan: s.mode === 'payment' ? 'lifetime' : 'pro',
            expires: s.mode === 'payment' ? null : new Date(Date.now()+365*24*60*60*1000).toISOString(),
          });
        }
      }
      if(event.type === 'customer.subscription.deleted') {
        const email = event.data.object.customer_email?.toLowerCase();
        if(email) {
          const l = await redis.get(`licence:${email}`);
          if(l) await redis.set(`licence:${email}`, {...l, status: 'cancelled'});
        }
      }
      if(event.type === 'charge.refunded') {
        const charge = event.data.object;
        // Chercher l'email à plusieurs endroits
        let email = charge.billing_details?.email?.toLowerCase();
        if(!email && charge.customer) {
          // Récupérer l'email depuis le customer Stripe
          try {
            const customer = await stripe.customers.retrieve(charge.customer);
            email = customer.email?.toLowerCase();
          } catch(e) {}
        }
        if(!email && charge.receipt_email) {
          email = charge.receipt_email.toLowerCase();
        }
        if(email) {
          const l = await redis.get(`licence:${email}`);
          if(l) await redis.set(`licence:${email}`, {...l, status: 'cancelled'});
          console.log(`↩ Remboursement — licence annulée : ${email}`);
        }
      }
    } catch(e) {
      return res.status(400).json({ error: e.message });
    }
    return res.json({ received: true });
  }

  // GET /success
  if(req.method === 'GET' && url.includes('/success')) {
    res.setHeader('Content-Type', 'text/html');
    return res.end(`<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<title>SYNC.PLANNER — Paiement confirmé</title>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;600;700&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Space Grotesk',sans-serif;background:#0A0910;color:#F0EEF8;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.card{background:#1A1838;border:1px solid #7C3AED;border-radius:20px;padding:48px 40px;max-width:480px;width:100%;text-align:center;box-shadow:0 0 60px rgba(124,58,237,0.2)}
.icon{font-size:64px;margin-bottom:24px}
h1{font-size:28px;font-weight:700;margin-bottom:12px}
p{font-size:15px;color:#7B78A8;line-height:1.6;margin-bottom:24px}
.steps{text-align:left;display:flex;flex-direction:column;gap:14px;margin-bottom:28px}
.step{display:flex;gap:12px;align-items:flex-start}
.num{width:26px;height:26px;border-radius:50%;background:#7C3AED;color:white;font-size:12px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.step p{font-size:14px;color:#C4C0E8;margin:0;padding-top:3px}
.btn{display:block;background:#7C3AED;color:white;border:none;border-radius:10px;padding:14px;font-family:'Space Grotesk',sans-serif;font-size:15px;font-weight:700;cursor:pointer;width:100%;margin-bottom:16px}
.footer{font-size:11px;color:#4B4870}
</style>
</head>
<body>
<div class="card">
  <div class="icon">🎉</div>
  <h1>Bienvenue en Pro !</h1>
  <p>Ton paiement est confirmé. SYNC.PLANNER Pro est actif.</p>
  <div class="steps">
    <div class="step"><div class="num">1</div><p>Retourne dans SYNC.PLANNER</p></div>
    <div class="step"><div class="num">2</div><p>Entre ton email dans l'écran d'activation</p></div>
    <div class="step"><div class="num">3</div><p>Clique <strong>"Activer ma licence"</strong> — c'est parti !</p></div>
  </div>
  <button class="btn" onclick="window.close()">✓ Fermer cette fenêtre</button>
  <div class="footer">Des questions ? contact@syncplanner.app</div>
</div>
</body>
</html>`);
  }

  return res.json({ status: 'SYNC.PLANNER API', version: '1.0.0' });
};

function getBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => data += c);
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
