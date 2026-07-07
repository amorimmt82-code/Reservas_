# O Melro - Sistema de Reservas de Salas

Sistema de reservas de salas de reunião com backend Supabase para uso em múltiplos dispositivos.

## Configuração do Supabase

### 1. Criar projeto no Supabase

1. Acesse [supabase.com](https://supabase.com) e crie uma conta gratuita
2. Clique em "New Project" e configure:
   - Nome do projeto: `o-melro-reservas`
   - Senha do banco de dados (guarde-a!)
   - Região: escolha a mais próxima

### 2. Configurar as tabelas

1. No painel do Supabase, vá em **SQL Editor**
2. Copie e cole todo o conteúdo do arquivo `supabase-setup.sql`
3. Clique em **Run** para executar

### 3. Configurar variáveis de ambiente

1. No Supabase, vá em **Settings** > **API**
2. Copie a **Project URL** e a **anon/public key**
3. Crie um arquivo `.env` na raiz do projeto:

```env
VITE_SUPABASE_URL=https://seu-projeto.supabase.co
VITE_SUPABASE_ANON_KEY=sua-chave-anon-aqui
```

### 4. Configurar autenticação

1. No Supabase, vá em **Authentication** > **Providers**
2. Certifique-se que **Email** está habilitado
3. Em **Authentication** > **URL Configuration**, configure:
   - Site URL: `http://localhost:3000` (desenvolvimento) ou seu domínio de produção

## Executar Localmente

```bash
npm install
npm run dev
```

## Deploy para Produção

### Opção 1: Vercel (Recomendado)

1. Conecte seu repositório no [Vercel](https://vercel.com)
2. Configure as variáveis de ambiente:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
3. Deploy automático a cada push

### Opção 2: Netlify

1. Conecte seu repositório no [Netlify](https://netlify.com)
2. Build command: `npm run build`
3. Publish directory: `dist`
4. Configure as mesmas variáveis de ambiente

## Funcionalidades

- ✅ Autenticação de usuários (registro/login)
- ✅ Reserva de salas com calendário visual
- ✅ Sincronização em tempo real entre dispositivos
- ✅ Prevenção de conflitos de horário
- ✅ Interface responsiva (desktop e mobile)

## Notificações por e‑mail (opcional)

O aplicativo pode disparar e‑mails quando convites são criados ou respondidos. Para ativar:

1. **Edge Function**: já existe um exemplo em `supabase/functions/sendInviteEmail/index.ts`.
   - Ajuste o código para o seu provedor (SendGrid, Mailgun, SES, etc.)
   - Faça deploy com `supabase functions deploy sendInviteEmail` ou use outro servidor.
2. **Variáveis de ambiente**:
   - `SENDGRID_API_KEY` (ou similar) no projeto Supabase
   - `VITE_EDGE_URL` apontando para a base da função (`https://<sua>.supabase.co/functions/v1`)
3. O frontend (`inviteService`) chamará automaticamente a função sempre que um convite for criado ou um convite for respondido.

Se não configurar nada, o código falhará silenciosamente e nenhuma mensagem será enviada; as notificações in‑app continuam funcionando normalmente.
