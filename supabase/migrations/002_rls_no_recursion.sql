-- group_members をサブクエリで再度読む RLS は無限再帰になり 500 になることがあります。
-- Supabase SQL エディタで実行してください（001 のあと想定）。

CREATE OR REPLACE FUNCTION public.is_member_of_group(p_group_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.group_members
    WHERE group_id = p_group_id AND user_id = auth.uid()::text
  );
$$;

REVOKE ALL ON FUNCTION public.is_member_of_group(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_member_of_group(uuid) TO authenticated;

DROP POLICY IF EXISTS "groups_select_member" ON public.groups;
DROP POLICY IF EXISTS "groups_update_member" ON public.groups;

CREATE POLICY "groups_select_member" ON public.groups FOR SELECT TO authenticated
USING (public.is_member_of_group(id));

CREATE POLICY "groups_update_member" ON public.groups FOR UPDATE TO authenticated
USING (public.is_member_of_group(id));

DROP POLICY IF EXISTS "gm_select_member" ON public.group_members;

CREATE POLICY "gm_select_member" ON public.group_members FOR SELECT TO authenticated
USING (public.is_member_of_group(group_id));

DROP POLICY IF EXISTS "se_select_member" ON public.shared_entries;
DROP POLICY IF EXISTS "se_insert_own" ON public.shared_entries;

CREATE POLICY "se_select_member" ON public.shared_entries FOR SELECT TO authenticated
USING (public.is_member_of_group(group_id));

CREATE POLICY "se_insert_own" ON public.shared_entries FOR INSERT TO authenticated
WITH CHECK (
  user_id = auth.uid()::text
  AND public.is_member_of_group(group_id)
);
