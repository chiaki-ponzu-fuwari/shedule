-- セキュリティ強化（003）: Dashboard → SQL から実行、または supabase db push
-- 前提: 001 / 002 が適用済み

-- ── groups: オーナー追跡（監査・招待コード制御用）と「最後に退出したユーザー」（空グループ削除の正当性）
ALTER TABLE public.groups ADD COLUMN IF NOT EXISTS owner_user_id text;
ALTER TABLE public.groups ADD COLUMN IF NOT EXISTS last_deleter_user_id text;

-- 既存データ: オーナーを group_members から補完
UPDATE public.groups g
SET owner_user_id = sub.uid
FROM (
  SELECT group_id, user_id AS uid
  FROM public.group_members
  WHERE is_owner = true
) sub
WHERE g.id = sub.group_id AND g.owner_user_id IS NULL;

UPDATE public.groups g
SET owner_user_id = (
  SELECT user_id FROM public.group_members gm WHERE gm.group_id = g.id LIMIT 1
)
WHERE g.owner_user_id IS NULL
  AND EXISTS (SELECT 1 FROM public.group_members gm2 WHERE gm2.group_id = g.id);

-- 最後に1人になったメンバーが group_members から自分を消す直前に、削除権を記録する
CREATE OR REPLACE FUNCTION public.group_members_set_last_deleter()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  cnt int;
BEGIN
  SELECT count(*)::int INTO cnt FROM public.group_members WHERE group_id = OLD.group_id;
  IF cnt = 1 THEN
    UPDATE public.groups
    SET last_deleter_user_id = OLD.user_id
    WHERE id = OLD.group_id;
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS group_members_last_deleter ON public.group_members;
CREATE TRIGGER group_members_last_deleter
  BEFORE DELETE ON public.group_members
  FOR EACH ROW
  EXECUTE PROCEDURE public.group_members_set_last_deleter();

-- 招待コードはオーナーのみ変更可（メンバーが PostgREST で invite_code だけ書き換えるのを防止）
CREATE OR REPLACE FUNCTION public.groups_enforce_owner_invite_code()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.invite_code IS DISTINCT FROM OLD.invite_code THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.group_members
      WHERE group_id = NEW.id AND user_id = auth.uid()::text AND is_owner = true
    ) THEN
      RAISE EXCEPTION 'invite_code change denied';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS groups_owner_invite_code ON public.groups;
CREATE TRIGGER groups_owner_invite_code
  BEFORE UPDATE ON public.groups
  FOR EACH ROW
  EXECUTE PROCEDURE public.groups_enforce_owner_invite_code();

-- RPC: 入力長の上限（DoS・肥大化の緩和）
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
  IF p_name IS NULL OR length(trim(p_name)) < 1 OR length(p_name) > 200 THEN
    RAISE EXCEPTION 'invalid name';
  END IF;
  IF p_color IS NOT NULL AND length(p_color) > 32 THEN
    RAISE EXCEPTION 'invalid color';
  END IF;
  IF p_emoji IS NOT NULL AND length(p_emoji) > 32 THEN
    RAISE EXCEPTION 'invalid emoji';
  END IF;
  IF p_user_name IS NOT NULL AND length(p_user_name) > 120 THEN
    RAISE EXCEPTION 'invalid user_name';
  END IF;

  inv := upper(substring(md5(random()::text || clock_timestamp()::text || random()::text) from 1 for 6));
  INSERT INTO public.groups (name, color, emoji, invite_code, shared_memo, owner_user_id)
  VALUES (trim(p_name), p_color, p_emoji, inv, '', auth.uid()::text)
  RETURNING * INTO g;
  INSERT INTO public.group_members (group_id, user_id, user_name, color, is_owner)
  VALUES (g.id, auth.uid()::text, trim(p_user_name), p_color, true);
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
  IF p_invite IS NULL OR length(trim(p_invite)) < 1 OR length(p_invite) > 32 THEN
    RAISE EXCEPTION 'invalid invite';
  END IF;
  IF p_user_name IS NOT NULL AND length(p_user_name) > 120 THEN
    RAISE EXCEPTION 'invalid user_name';
  END IF;
  IF p_color IS NOT NULL AND length(p_color) > 32 THEN
    RAISE EXCEPTION 'invalid color';
  END IF;

  SELECT * INTO g FROM public.groups WHERE upper(trim(invite_code)) = upper(trim(p_invite)) LIMIT 1;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM public.group_members WHERE group_id = g.id AND user_id = auth.uid()::text) THEN
    RETURN g;
  END IF;
  INSERT INTO public.group_members (group_id, user_id, user_name, color, is_owner)
  VALUES (g.id, auth.uid()::text, trim(p_user_name), p_color, false);
  RETURN g;
END;
$$;

-- 空グループの削除: 「最後にメンバー行を削除した本人」または移行前データ（last_deleter 未設定時は owner のみ）
DROP POLICY IF EXISTS "groups_delete_empty" ON public.groups;

CREATE POLICY "groups_delete_empty" ON public.groups FOR DELETE TO authenticated
USING (
  NOT EXISTS (SELECT 1 FROM public.group_members gm WHERE gm.group_id = groups.id)
  AND (
    last_deleter_user_id = auth.uid()::text
    OR (
      last_deleter_user_id IS NULL
      AND owner_user_id = auth.uid()::text
    )
  )
);
