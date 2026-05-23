// Vercel serverless function — Resend メール送信
// 環境変数: RESEND_API_KEY, EMAIL_TO, EMAIL_FROM (optional)
const { Resend } = require('resend');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.RESEND_API_KEY;
  const to     = process.env.EMAIL_TO;
  const from   = process.env.EMAIL_FROM || 'Smile Shutter <onboarding@resend.dev>';

  if (!apiKey) return res.status(500).json({ error: 'RESEND_API_KEY is not configured' });
  if (!to)     return res.status(500).json({ error: 'EMAIL_TO is not configured' });

  const { shots } = req.body ?? {};
  if (!Array.isArray(shots) || shots.length === 0) {
    return res.status(400).json({ error: 'No shots provided' });
  }

  const resend = new Resend(apiKey);

  const attachments = shots.map((shot, i) => ({
    filename: `smile_${String(i + 1).padStart(2, '0')}_${Math.round(shot.score * 100)}pct.jpg`,
    content:  Buffer.from(shot.dataUrl.split(',')[1], 'base64'),
  }));

  const best    = shots.reduce((a, b) => a.score > b.score ? a : b);
  const avgPct  = Math.round(shots.reduce((s, sh) => s + sh.score, 0) / shots.length * 100);
  const bestPct = Math.round(best.score * 100);

  const html = `
    <h2 style="color:#333;font-family:sans-serif">📸 笑顔セッション完了</h2>
    <p style="font-family:sans-serif">${shots.length}枚の笑顔写真が添付されています。</p>
    <table style="border-collapse:collapse;font-family:sans-serif">
      <tr><td style="padding:4px 12px 4px 0">撮影枚数</td><td><b>${shots.length}枚</b></td></tr>
      <tr><td style="padding:4px 12px 4px 0">ベストスコア</td><td><b>${bestPct}%</b></td></tr>
      <tr><td style="padding:4px 12px 4px 0">平均スコア</td><td><b>${avgPct}%</b></td></tr>
    </table>
  `;

  try {
    await resend.emails.send({
      from,
      to,
      subject: `📸 笑顔セッション完了 — ${shots.length}枚撮影 / ベスト ${bestPct}%`,
      html,
      attachments,
    });
    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

module.exports.config = {
  api: { bodyParser: { sizeLimit: '20mb' } },
};
