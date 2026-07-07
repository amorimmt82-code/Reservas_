-- =============================================
-- SQL para criar as tabelas no Supabase
-- Execute este script no SQL Editor do Supabase
-- =============================================

-- Habilitar extensão necessária para constraint de overlap
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Tabela de salas
CREATE TABLE IF NOT EXISTS rooms (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  capacity INTEGER NOT NULL,
  amenities TEXT[] DEFAULT '{}',
  image_url TEXT,
  floor TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Tabela de reservas
CREATE TABLE IF NOT EXISTS bookings (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  room_id UUID REFERENCES rooms(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  organizer_name TEXT NOT NULL,
  meeting_title TEXT NOT NULL,
  start_time TIMESTAMP WITH TIME ZONE NOT NULL,
  end_time TIMESTAMP WITH TIME ZONE NOT NULL,
  color TEXT DEFAULT '#10b981',
  recurrence_group_id UUID,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Tabela de convites
CREATE TABLE IF NOT EXISTS invites (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  booking_id UUID REFERENCES bookings(id) ON DELETE CASCADE,
  inviter_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  inviter_name TEXT NOT NULL,
  invitee_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  invitee_name TEXT NOT NULL,
  invitee_email TEXT,                     -- <== campo para armazenar o e-mail do convidado
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled')),
  room_name TEXT NOT NULL,
  meeting_title TEXT NOT NULL,
  start_time TIMESTAMP WITH TIME ZONE NOT NULL,
  end_time TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Tabela de perfis (para listar todos os utilizadores no convite)
CREATE TABLE IF NOT EXISTS profiles (
  id UUID REFERENCES auth.users(id) ON DELETE CASCADE PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  avatar_url TEXT,
  password_plain TEXT,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Trigger para criar perfil automaticamente quando um utilizador se regista
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, name, email, avatar_url)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'name', NEW.email),
    NEW.email,
    'https://ui-avatars.com/api/?name=' || COALESCE(NEW.raw_user_meta_data->>'name', 'User') || '&background=0c3c24&color=fff'
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Criar trigger no auth.users (só cria se não existir)
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Caso esteja a atualizar um projeto existente, adicionar coluna de email no invites
ALTER TABLE invites ADD COLUMN IF NOT EXISTS invitee_email TEXT;

-- Caso esteja a atualizar, adicionar coluna password_plain no profiles
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS password_plain TEXT;

-- Constraint para evitar reservas sobrepostas na mesma sala (requer btree_gist)
ALTER TABLE bookings ADD CONSTRAINT no_overlap 
  EXCLUDE USING gist (
    room_id WITH =,
    tstzrange(start_time, end_time) WITH &&
  );

-- Índices para melhor performance
CREATE INDEX IF NOT EXISTS idx_bookings_room_id ON bookings(room_id);
CREATE INDEX IF NOT EXISTS idx_bookings_user_id ON bookings(user_id);
CREATE INDEX IF NOT EXISTS idx_bookings_start_time ON bookings(start_time);

-- Habilitar RLS (Row Level Security)
ALTER TABLE rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;

-- Policy: Todos podem ver as salas
CREATE POLICY "Salas visíveis para todos" ON rooms
  FOR SELECT USING (true);

-- Policy: Todos autenticados podem ver todas as reservas
CREATE POLICY "Reservas visíveis para autenticados" ON bookings
  FOR SELECT USING (auth.role() = 'authenticated');

-- Policy: Usuários autenticados podem criar reservas
CREATE POLICY "Usuários podem criar reservas" ON bookings
  FOR INSERT WITH CHECK (auth.role() = 'authenticated');

-- Policy: Usuários podem deletar suas próprias reservas
CREATE POLICY "Usuários podem deletar próprias reservas" ON bookings
  FOR DELETE USING (auth.uid() = user_id);

-- Policy: Usuários podem atualizar suas próprias reservas
CREATE POLICY "Usuários podem atualizar próprias reservas" ON bookings
  FOR UPDATE USING (auth.uid() = user_id);

-- RLS para convites
ALTER TABLE invites ENABLE ROW LEVEL SECURITY;

-- RLS para perfis
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

-- Policy: Todos autenticados podem ver todos os perfis
CREATE POLICY "Perfis visíveis para autenticados" ON profiles
  FOR SELECT USING (auth.role() = 'authenticated');

-- Policy: Utilizadores podem inserir/atualizar o seu próprio perfil
CREATE POLICY "Utilizadores podem inserir perfil" ON profiles
  FOR INSERT WITH CHECK (auth.uid() = id);

CREATE POLICY "Utilizadores podem atualizar perfil" ON profiles
  FOR UPDATE USING (auth.uid() = id);

-- Policy para o trigger (service role pode inserir perfis)
CREATE POLICY "Service role pode gerir perfis" ON profiles
  FOR ALL USING (true) WITH CHECK (true);

-- Policy: Todos autenticados podem ver todos os convites (para ver convidados de qualquer reunião)
CREATE POLICY "Convites visíveis para autenticados" ON invites
  FOR SELECT USING (auth.role() = 'authenticated');

-- Policy: Autenticados podem criar convites
CREATE POLICY "Criar convites" ON invites
  FOR INSERT WITH CHECK (auth.role() = 'authenticated');

-- Policy: Invitees podem atualizar convites deles (aceitar/recusar)
CREATE POLICY "Atualizar convites como invitee" ON invites
  FOR UPDATE USING (auth.uid() = invitee_id);

-- Policy: Inviters podem deletar convites
CREATE POLICY "Deletar convites como inviter" ON invites
  FOR DELETE USING (auth.uid() = inviter_id);

-- =============================================
-- Inserir salas iniciais
-- =============================================
INSERT INTO rooms (id, name, capacity, amenities, image_url, floor) VALUES
  ('11111111-1111-1111-1111-111111111111', 'R/C Direito', 12, ARRAY['TV 4K', 'Videoconferência', 'Quadro Branco'], 'https://images.unsplash.com/photo-1497366216548-37526070297c?auto=format&fit=crop&w=800&q=80', 'R/C'),
  ('22222222-2222-2222-2222-222222222222', 'R/C Esquerdo', 6, ARRAY['Projetor', 'Sistema de Som', 'Puffs'], 'https://images.unsplash.com/photo-1497366811353-6870744d04b2?auto=format&fit=crop&w=800&q=80', 'R/C'),
  ('33333333-3333-3333-3333-333333333333', 'Primeiro Andar', 4, ARRAY['Privativo', 'Máquina de Café', 'Vista Panorâmica'], 'https://images.unsplash.com/photo-1577412647305-991150c7d163?auto=format&fit=crop&w=800&q=80', '1º Andar')
ON CONFLICT (id) DO NOTHING;

-- =============================================
-- Habilitar Realtime nas tabelas
-- (necessário para notificações em tempo real)
-- =============================================
ALTER PUBLICATION supabase_realtime ADD TABLE bookings;
ALTER PUBLICATION supabase_realtime ADD TABLE invites;
