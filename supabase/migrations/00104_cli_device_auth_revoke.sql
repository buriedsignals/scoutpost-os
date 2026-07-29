REVOKE ALL ON FUNCTION
  public.consume_cli_auth_rate_limit(text, text, integer, integer),
  public.create_api_key_atomic(uuid, text, text),
  public.decide_cli_device_authorization(text, uuid, text),
  public.redeem_cli_device_authorization(text),
  public.validate_api_key_identity(text),
  public.revoke_current_api_key(text),
  public.cleanup_cli_device_authorizations()
FROM PUBLIC, anon, authenticated;
