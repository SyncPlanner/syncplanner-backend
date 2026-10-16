const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { Redis } = require('@upstash/redis');

// L'intégration Upstash Redis via le Marketplace Vercel peut injecter les
// identifiants sous des noms légèrement différents selon la version —
// on couvre les deux conventions les plus courantes.
const redis = new Redis({
  url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN,
});

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if(req.method === 'OPTIONS') return res.status(200).end();

  const url = req.url || '';

  // GET /verify/:email?device=<deviceId>
  // Vérification en lecture seule : la licence doit être active ET, si un
  // deviceId est fourni, cet appareil doit déjà faire partie des appareils
  // enregistrés (2 max) — sinon on ne le fait PAS entrer automatiquement,
  // c'est /activate qui consomme un slot, explicitement.
  if(req.method === 'GET' && url.includes('/verify/')) {
    const [emailRaw, qs] = url.split('/verify/')[1].split('?');
    const email = decodeURIComponent(emailRaw).toLowerCase();
    const deviceId = qs ? new URLSearchParams(qs).get('device') : null;

    const licence = await redis.get(`licence:${email}`);
    if(!licence || licence.status !== 'active') {
      return res.json({ valid: false });
    }
    if(deviceId) {
      const devices = licence.devices || [];
      const known = devices.some(d => d.id === deviceId);
      if(!known) return res.json({ valid: false, reason: 'device_not_activated' });
    }
    return res.json({ valid: true, plan: licence.plan, expires: licence.expires, devices: licence.devices || [] });
  }

  // POST /deactivate — { email, deviceId }
  // Libère un slot d'appareil (ex: ancien Mac revendu) pour permettre
  // d'en activer un nouveau sans dépasser la limite de 2.
  if(req.method === 'POST' && url.includes('/deactivate')) {
    const body = await getBody(req);
    try {
      const { email, deviceId } = JSON.parse(body);
      if(!email || !deviceId) return res.status(400).json({ error: 'email et deviceId requis' });

      const key = `licence:${email.toLowerCase()}`;
      const licence = await redis.get(key);
      if(!licence) return res.status(404).json({ error: 'Licence introuvable' });

      licence.devices = (licence.devices || []).filter(d => d.id !== deviceId);
      await redis.set(key, licence);
      return res.json({ valid: true, devices: licence.devices });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // POST /activate — { email, deviceId, deviceName }
  // Enregistre CET appareil sur la licence (2 max). Ré-activer un appareil
  // déjà enregistré est sans effet (idempotent) — utile en cas de
  // réinstallation de l'app sur la même machine.
  if(req.method === 'POST' && url.includes('/activate')) {
    const body = await getBody(req);
    try {
      const { email, deviceId, deviceName } = JSON.parse(body);
      if(!email || !deviceId) return res.status(400).json({ error: 'email et deviceId requis' });

      const key = `licence:${email.toLowerCase()}`;
      const licence = await redis.get(key);
      if(!licence || licence.status !== 'active') {
        return res.json({ valid: false, reason: 'no_active_licence' });
      }

      const devices = licence.devices || [];
      const existing = devices.find(d => d.id === deviceId);
      if(existing) {
        existing.lastSeen = new Date().toISOString();
        await redis.set(key, licence);
        return res.json({ valid: true, plan: licence.plan, expires: licence.expires });
      }

      if(devices.length >= 2) {
        return res.json({
          valid: false,
          reason: 'device_limit',
          devices: devices.map(d => ({ name: d.name, activatedAt: d.activatedAt })),
        });
      }

      devices.push({ id: deviceId, name: deviceName || 'Mac', activatedAt: new Date().toISOString(), lastSeen: new Date().toISOString() });
      licence.devices = devices;
      await redis.set(key, licence);
      return res.json({ valid: true, plan: licence.plan, expires: licence.expires });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
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
        metadata: { plan: prices[plan] ? plan : 'monthly' },
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
            // Abonnement : 1re période (≈ 1 mois ou 1 an selon la formule) ; prolongée ensuite par invoice.paid
            expires: s.mode === 'payment' ? null : new Date(Date.now() + (s.metadata?.plan === 'yearly' ? 368 : 34) * 24 * 60 * 60 * 1000).toISOString(),
            devices: (await redis.get(`licence:${email}`))?.devices || [],
          });
        }
      }
      // Abonnement terminé (résilié et période payée écoulée, ou impayé) → licence coupée.
      // L'objet subscription n'a pas d'email : on le récupère via le client Stripe.
      if(event.type === 'customer.subscription.deleted') {
        const email = await emailOfCustomer(event.data.object.customer);
        if(email) {
          const l = await redis.get(`licence:${email}`);
          if(l && l.plan !== 'lifetime') await redis.set(`licence:${email}`, {...l, status: 'cancelled'});
        }
      }
      // Chaque paiement d'abonnement (1er mois, renouvellements) → licence active jusqu'à la fin de la période payée
      if(event.type === 'invoice.paid') {
        const inv = event.data.object;
        if(inv.subscription || inv.parent?.subscription_details?.subscription) {
          const email = inv.customer_email?.toLowerCase() || await emailOfCustomer(inv.customer);
          const end = inv.lines?.data?.[0]?.period?.end;
          if(email) {
            const l = (await redis.get(`licence:${email}`)) || {};
            if(l.plan !== 'lifetime') await redis.set(`licence:${email}`, {
              ...l, status: 'active', plan: 'pro',
              expires: end ? new Date((end + 3 * 86400) * 1000).toISOString() : (l.expires || null),   // +3 j de marge
            });
          }
        }
      }
      // Remboursement intégral (garantie 14 jours) → licence coupée. Un remboursement partiel ne touche pas la licence.
      if(event.type === 'charge.refunded' && event.data.object.refunded === true) {
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
  <button class="btn" onclick="window.close();window.location.href='https://syncplanner.app'">✓ Retourner sur syncplanner.app</button>
  <div class="footer">Des questions ? contact@syncplanner.app</div>
</div>
</body>
</html>`);
  }

  return res.json({ status: 'SYNC.PLANNER API', version: '1.0.0' });
};

async function emailOfCustomer(id) {
  if(!id) return null;
  try { const c = await stripe.customers.retrieve(id); return c.email?.toLowerCase() || null; } catch(e) { return null; }
}

function getBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => data += c);
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
