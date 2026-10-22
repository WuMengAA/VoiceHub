-- ============================================================================
-- 给开放 API Key 授予「排期重排写」权限（schedules:write）
-- 对应端点：POST /api/open/schedules/reorder（被控端拖拽排序持久化）
--
-- 表结构（见 app/drizzle/schema.ts）：
--   api_keys            (id uuid PK, name, key_prefix, is_active, expires_at, ...)
--   api_key_permissions (id uuid PK, api_key_id uuid, permission varchar(100), created_at)
--
-- 执行：psql "$DATABASE_URL" -f scripts/grant-schedules-write.sql
--       或在数据库控制台直接粘贴。
-- 说明：gen_random_uuid() 在 Postgres 13+ 为内置；若报函数不存在，先执行
--       CREATE EXTENSION IF NOT EXISTS pgcrypto;
-- ============================================================================

-- ① 先列出 Key，确认要授权的是哪一把（按 name 或 key_prefix 认）
--    ⚠️ keyHash 不可逆，别用明文 key 反查；用 name / key_prefix 定位。
-- SELECT id, name, key_prefix, is_active, expires_at, created_at
-- FROM api_keys
-- ORDER BY created_at DESC;

-- ② 授权（幂等：重复执行不会插入重复行）
--    把 '被控端使用的Key名称' 换成上面查到的 Key 名称。
--    也可以改用前缀匹配：把下面第一处 WHERE 换成 k.key_prefix = 'vhub_xxxxxxxx'。
INSERT INTO api_key_permissions (id, api_key_id, permission, created_at)
SELECT gen_random_uuid(), k.id, 'schedules:write', now()
FROM api_keys k
WHERE k.name = '被控端使用的Key名称'          -- ← 改这里
  AND NOT EXISTS (
    SELECT 1
    FROM api_key_permissions p
    WHERE p.api_key_id = k.id
      AND p.permission = 'schedules:write'
  );

-- ③ 复核（应能看到该 Key 的 schedules:write 行）
-- SELECT k.id, k.name, k.key_prefix, p.permission, p.created_at
-- FROM api_key_permissions p
-- JOIN api_keys k ON k.id = p.api_key_id
-- WHERE p.permission = 'schedules:write'
-- ORDER BY p.created_at DESC;

-- ④ 撤销（如需回收该权限）
-- DELETE FROM api_key_permissions p
-- USING api_keys k
-- WHERE p.api_key_id = k.id
--   AND k.name = '被控端使用的Key名称'
--   AND p.permission = 'schedules:write';
