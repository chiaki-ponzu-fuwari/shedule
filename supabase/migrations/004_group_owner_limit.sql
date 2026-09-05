-- オーナーとして参加できるグループ数の上限（無料枠の保護・悪用防止）
-- 003 のあとに実行。SQL Editor で全体実行。

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
  owner_count int;
  max_groups int := 10;
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

  SELECT count(*)::int INTO owner_count
  FROM public.group_members
  WHERE user_id = auth.uid()::text AND is_owner = true;

  IF owner_count >= max_groups THEN
    RAISE EXCEPTION 'group_limit_reached';
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
