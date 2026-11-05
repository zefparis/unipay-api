-- ============================================================
-- Durcissement du bucket merchant-kyc-docs (correctif §D)
-- ============================================================
-- Upload direct navigateur → Supabase via URL signée : la limite
-- est appliquée par Storage lui-même (défense en profondeur en plus
-- des contrôles de /merchant/kyc/upload-url).
UPDATE storage.buckets
SET file_size_limit   = 10485760,  -- 10 Mo par fichier
    allowed_mime_types = '{application/pdf,image/jpeg,image/png}'
WHERE id = 'merchant-kyc-docs';
