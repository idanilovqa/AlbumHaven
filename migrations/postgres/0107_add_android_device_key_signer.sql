-- Additive: the signing certificate each device key's attestation matched, rechecked on every use.
-- Keys attested before this column existed keep null and are refused until the app attests again.
alter table app.android_device_keys
  add column if not exists signing_certificate_sha256 bytea
    check (signing_certificate_sha256 is null or octet_length(signing_certificate_sha256) = 32);
