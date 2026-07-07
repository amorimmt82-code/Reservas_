import express from 'express';
import cors from 'cors';
import nodemailer from 'nodemailer';
import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';

config();

const app = express();
app.use(cors());
app.use(express.json());

const EMAIL_USER = process.env.EMAIL_USER || '';
const EMAIL_PASS = process.env.EMAIL_PASS || '';
// Zoho SMTP por padrão. Para contas Zoho EU use smtp.zoho.eu
const SMTP_HOST = process.env.SMTP_HOST || 'smtp.zoho.com';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '465', 10);
const SMTP_SECURE = (process.env.SMTP_SECURE ?? 'true') !== 'false'; // true para 465 (SSL), false para 587 (STARTTLS)
const EMAIL_FROM_NAME = process.env.EMAIL_FROM_NAME || 'Reservas O Melro';

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY || '';

// Prefer service role key (bypasses RLS), fallback to anon key
const supabaseAdmin = SUPABASE_URL && (SUPABASE_SERVICE_KEY || SUPABASE_ANON_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY || SUPABASE_ANON_KEY, {
      auth: { autoRefreshToken: false, persistSession: false }
    })
  : null;

const transporter = EMAIL_USER && EMAIL_PASS
  ? nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_SECURE,
      auth: { user: EMAIL_USER, pass: EMAIL_PASS },
    })
  : null;

async function sendEmail(to, subject, text, html) {
  if (!transporter) {
    console.warn('[proxy] Email não configurado. Defina EMAIL_USER e EMAIL_PASS no .env');
    return { success: false, reason: 'email not configured' };
  }
  try {
    console.log('[proxy] Enviando email para:', to, '| Assunto:', subject);
    await transporter.sendMail({
      from: `"${EMAIL_FROM_NAME}" <${EMAIL_USER}>`,
      to,
      subject,
      text,
      ...(html ? { html } : {}),
    });
    console.log('[proxy] ✅ Email enviado para', to);
    return { success: true };
  } catch (err) {
    console.error('[proxy] ❌ Erro ao enviar email:', err.message);
    return { success: false, error: err.message };
  }
}

app.post('/api/sendInviteEmail', async (req, res) => {
  try {
    const body = req.body;

    // --- Notificação de reserva ---
    if (body.notification === true) {
      const { to, subject, message, html } = body;
      if (!to) return res.json({ success: false, reason: 'no recipient' });
      const result = await sendEmail(to, subject || 'Nova reserva', message || 'Uma nova reserva foi criada.', html);
      return res.json(result);
    }

    // --- Notificação de convite ---
    const { invite, action } = body;
    if (!invite || !invite.inviteeEmail) {
      return res.json({ success: false, reason: 'no invitee email' });
    }

    const subjects = {
      created: `Convite para ${invite.meetingTitle}`,
      accepted: `Convite aceito por ${invite.inviteeName}`,
      declined: `Convite recusado por ${invite.inviteeName}`,
      cancelled: `Reunião cancelada: ${invite.meetingTitle}`,
    };

    const bodyTexts = {
      created: (inv) =>
        `Olá ${inv.inviteeName},\n\n` +
        `Você foi convidado para a reunião "${inv.meetingTitle}" na sala ${inv.roomName}.\n` +
        `Início: ${new Date(inv.startTime).toLocaleString('pt-BR', { timeZone: 'Europe/Lisbon' })}\n` +
        `Fim: ${new Date(inv.endTime).toLocaleTimeString('pt-BR', { timeZone: 'Europe/Lisbon' })}\n\n` +
        `Deseja confirmar a presença?\nAcesse o aplicativo para responder ao convite.`,
      accepted: (inv) =>
        `${inv.inviteeName} acabou de aceitar o convite para "${inv.meetingTitle}".`,
      declined: (inv) =>
        `${inv.inviteeName} recusou o convite para "${inv.meetingTitle}".`,
      cancelled: (inv) =>
        `A reunião "${inv.meetingTitle}" na sala ${inv.roomName} marcada para ${new Date(inv.startTime).toLocaleString('pt-BR', { timeZone: 'Europe/Lisbon' })} foi cancelada.`,
    };

    const subj = subjects[action] || 'Notificação de convite';
    const text = bodyTexts[action] ? bodyTexts[action](invite) : 'Notificação de convite.';

    const result = await sendEmail(invite.inviteeEmail, subj, text);
    return res.json(result);
  } catch (err) {
    console.error('[proxy] Erro:', err);
    res.status(500).json({ error: String(err) });
  }
});

const PORT = process.env.PORT || 4000;

// --- Endpoint: Esqueceu a senha ---
app.post('/api/forgotPassword', async (req, res) => {
  try {
    const { email, password_plain: clientPassword } = req.body;
    if (!email) {
      return res.json({ success: false, reason: 'E-mail é obrigatório.' });
    }

    // Se o cliente enviou a senha diretamente (fallback quando proxy não tem service key)
    if (clientPassword) {
      const subject = 'Recuperação de senha - Reservas';
      const text = `Olá,\n\nEstá aqui a sua senha seu esquecidinho:\n\n${clientPassword}\n\nNão partilhe com ninguém!`;
      const result = await sendEmail(email, subject, text);
      return res.json(result);
    }

    if (!supabaseAdmin) {
      return res.json({ success: false, reason: 'Supabase não configurado no servidor.' });
    }

    // Buscar a senha guardada na tabela profiles
    console.log('[proxy] Buscando perfil para email:', email);
    const { data, error } = await supabaseAdmin
      .from('profiles')
      .select('name, password_plain')
      .eq('email', email)
      .single();

    console.log('[proxy] Resultado query profiles:', { data, error: error?.message });

    if (error || !data) {
      return res.json({ success: false, reason: 'E-mail não encontrado.' });
    }

    if (!data.password_plain) {
      return res.json({ success: false, reason: 'Senha não disponível. Registe-se novamente.' });
    }

    const nome = data.name || 'utilizador';
    const subject = 'Recuperação de senha - Reservas';
    const text = `Olá ${nome},\n\nEstá aqui a sua senha seu esquecidinho:\n\n${data.password_plain}\n\nNão partilhe com ninguém!`;

    const result = await sendEmail(email, subject, text);
    return res.json(result);
  } catch (err) {
    console.error('[proxy] Erro forgot password:', err);
    res.status(500).json({ success: false, error: String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`Proxy rodando em http://localhost:${PORT}`);
  if (!transporter) {
    console.warn('⚠️  Configure EMAIL_USER e EMAIL_PASS no .env para enviar emails');
  } else {
    console.log(`✅ Email configurado com ${EMAIL_USER} via ${SMTP_HOST}:${SMTP_PORT} (secure=${SMTP_SECURE})`);
  }
});
