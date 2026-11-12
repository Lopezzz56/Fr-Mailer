-- Ensure the private template-attachments storage bucket exists in Supabase Storage.
-- This runs safely on Postgres when the storage schema is present (Supabase),
-- and is safely ignored if deployed to a standalone Postgres without the storage schema.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'storage') THEN
    INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    VALUES (
      'template-attachments',
      'template-attachments',
      false,
      10485760,
      ARRAY[
        'application/pdf',
        'application/vnd.ms-powerpoint',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'image/png',
        'image/jpeg',
        'image/gif',
        'image/webp'
      ]::text[]
    )
    ON CONFLICT (id) DO UPDATE SET
      public = false,
      file_size_limit = 10485760,
      allowed_mime_types = ARRAY[
        'application/pdf',
        'application/vnd.ms-powerpoint',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'image/png',
        'image/jpeg',
        'image/gif',
        'image/webp'
      ]::text[];
  END IF;
END $$;

