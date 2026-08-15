const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const licences = {};

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if(req.method === 'OPTIONS') return res.status(200).end();
  const url = req.url || '';
  if(req.method === 'GET' && url.includes('/verify/')) {
    const email = decodeURIComponent(url.split('/verify/')[1]).toLowerCase();
    const licence = licences[email];
    if(licence && licence.status === 'active') {
      return res.json({ valid: true, plan: licence.plan, expires: licence.expires });
    }
    return res.json({ valid: false });
  }
  if(req.method === 'POST' && url.includes('/create-checkout')) {
    const body = await getBody(req);
    const { email, plan } = JSON.parse(body);
    const prices = { monthly: process.env.PRICE_MONTHLY, yearly: process.env.PRICE_YEARLY, lifetime: process.env.PRICE_LIFETIME };
    try {
      const session = await stripe.checkout.sessions.create({
        mode: plan === 'lifetime' ? 'payment' : 'subscription',
        customer_email: email,
        line_items: [{ price: prices[plan]||prices.monthly, quantity: 1 }],
        success_url: 'https://syncplanner-api.vercel.app/success',
        cancel_url: 'https://syncplanner-api.vercel.app/cancel',
      });
      return res.json({ url: session.url });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }
  if(req.method === 'POST' && url.includes('/webhook')) {
    const rawBody = await getBody(req);
    try {
      const event = stripe.webhooks.constructEvent(rawBody, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
      if(event.type === 'checkout.session.completed') {
        const s = event.data.object;
        const email = s.customer_email?.toLowerCase();
        if(email) licences[email] = { status: 'active', plan: s.mode === 'payment' ? 'lifetime' : 'pro', expires: s.mode === 'payment' ? null : new Date(Date.now()+365*24*60*60*1000).toISOString() };
      }
      if(event.type === 'customer.subscription.deleted') {
        const email = event.data.object.customer_email?.toLowerCase();
        if(email && licences[email]) licences[email].status = 'cancelled';
      }
    } catch(e) { return res.status(400).json({ error: e.message }); }
    return res.json({ received: true });
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
