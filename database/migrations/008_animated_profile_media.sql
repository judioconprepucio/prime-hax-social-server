ALTER TABLE profile_media
  DROP CONSTRAINT IF EXISTS profile_media_mime_type_check;

ALTER TABLE profile_media
  ADD CONSTRAINT profile_media_mime_type_check
  CHECK (mime_type IN (
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/gif',
    'video/mp4',
    'video/webm'
  ));

ALTER TABLE profile_media
  DROP CONSTRAINT IF EXISTS profile_media_byte_size_check;

ALTER TABLE profile_media
  ADD CONSTRAINT profile_media_byte_size_check
  CHECK (byte_size > 0 AND byte_size <= 10485760);
