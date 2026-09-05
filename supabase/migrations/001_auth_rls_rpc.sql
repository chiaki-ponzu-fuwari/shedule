-- Supabase SQL エディタで「全体を実行」するか、Dashboard → SQL → New query から貼り付け。
-- 事前に Authentication → Providers → Anonymous を有効にしてください。
--
-- 既存の「allow all」ポリシーを削除し、auth.uid() ベースの RLS と RPC に置き換えます。
-- 適用後は旧クライアント（user_ 形式の user_id）は DB 上のデータと一致しなくなる点に注意。

-- gen_random_bytes は pgcrypto 必須のため使わず、拡張なしで動く乱数で招待コードを作る

-- 旧ポリシー（名前が違う場合は Dashboard で確認してから DROP）
DROP POLICY IF EXISTS "allow all" ON public.groups;
DROP POLICY IF EXISTS "allow all" ON public.group_members;
DROP POLICY IF EXISTS "allow all" ON public.shared_entries;

-- 既存 RPC を上書きする場合
DROP FUNCTION IF EXISTS public.create_group_with_owner(text, text, text, text);
DROP FUNCTION IF EXISTS public.join_group_by_invite(text, text, text);

CREATE OR REPLACE FUNCTION public.create_group_with_owner(
  p_name text,
  p_color text,
  p_emoji text,
  p_user_name text
)
RETURNS public.groups
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  g public.groups%ROWTYPE;
  inv text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  inv := upper(substring(md5(random()::text || clock_timestamp()::text || random()::text) from 1 for 6));
  INSERT INTO public.groups (name, color, emoji, invite_code, shared_memo)
  VALUES (p_name, p_color, p_emoji, inv, '')
  RETURNING * INTO g;
  INSERT INTO public.group_members (group_id, user_id, user_name, color, is_owner)
  VALUES (g.id, auth.uid()::text, p_user_name, p_color, true);
  RETURN g;
END;
$$;

CREATE OR REPLACE FUNCTION public.join_group_by_invite(
  p_invite text,
  p_user_name text,
  p_color text
)
RETURNS public.groups
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  g public.groups%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  SELECT * INTO g FROM public.groups WHERE upper(trim(invite_code)) = upper(trim(p_invite)) LIMIT 1;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM public.group_members WHERE group_id = g.id AND user_id = auth.uid()::text) THEN
    RETURN g;
  END IF;
  INSERT INTO public.group_members (group_id, user_id, user_name, color, is_owner)
  VALUES (g.id, auth.uid()::text, p_user_name, p_color, false);
  RETURN g;
END;
$$;

REVOKE ALL ON FUNCTION public.create_group_with_owner(text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.join_group_by_invite(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_group_with_owner(text, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.join_group_by_invite(text, text, text) TO authenticated;

-- RLS（再実行時は同名ポリシーを DROP してから）
DROP POLICY IF EXISTS "groups_select_member" ON public.groups;
DROP POLICY IF EXISTS "groups_update_member" ON public.groups;
DROP POLICY IF EXISTS "groups_delete_empty" ON public.groups;

CREATE POLICY "groups_select_member" ON public.groups FOR SELECT TO authenticated
USING (
  id IN (SELECT gm.group_id FROM public.group_members gm WHERE gm.user_id = auth.uid()::text)
);

CREATE POLICY "groups_update_member" ON public.groups FOR UPDATE TO authenticated
USING (
  id IN (SELECT gm.group_id FROM public.group_members gm WHERE gm.user_id = auth.uid()::text)
);

-- メンバーが自分だけのときに退出すると group_members が空になり、その後クライアントが groups を削除する想定
CREATE POLICY "groups_delete_empty" ON public.groups FOR DELETE TO authenticated
USING (
  NOT EXISTS (SELECT 1 FROM public.group_members gm WHERE gm.group_id = groups.id)
);

DROP POLICY IF EXISTS "gm_select_member" ON public.group_members;
DROP POLICY IF EXISTS "gm_delete_self" ON public.group_members;

CREATE POLICY "gm_select_member" ON public.group_members FOR SELECT TO authenticated
USING (
  group_id IN (SELECT gm.group_id FROM public.group_members gm WHERE gm.user_id = auth.uid()::text)
);

CREATE POLICY "gm_delete_self" ON public.group_members FOR DELETE TO authenticated
USING (user_id = auth.uid()::text);

DROP POLICY IF EXISTS "se_select_member" ON public.shared_entries;
DROP POLICY IF EXISTS "se_insert_own" ON public.shared_entries;
DROP POLICY IF EXISTS "se_delete_own" ON public.shared_entries;
DROP POLICY IF EXISTS "se_update_own" ON public.shared_entries;

CREATE POLICY "se_select_member" ON public.shared_entries FOR SELECT TO authenticated
USING (
  group_id IN (SELECT gm.group_id FROM public.group_members gm WHERE gm.user_id = auth.uid()::text)
);

CREATE POLICY "se_insert_own" ON public.shared_entries FOR INSERT TO authenticated
WITH CHECK (
  user_id = auth.uid()::text
  AND group_id IN (SELECT gm.group_id FROM public.group_members gm WHERE gm.user_id = auth.uid()::text)
);

CREATE POLICY "se_delete_own" ON public.shared_entries FOR DELETE TO authenticated
USING (user_id = auth.uid()::text);

CREATE POLICY "se_update_own" ON public.shared_entries FOR UPDATE TO authenticated
USING (user_id = auth.uid()::text)
WITH CHECK (user_id = auth.uid()::text);
