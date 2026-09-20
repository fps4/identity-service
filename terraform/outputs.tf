output "api_url" {
  description = "The HTTP API's default endpoint. The realm answers here whether or not a domain is mapped."
  value       = aws_apigatewayv2_api.this.api_endpoint
}

output "api_id" {
  value = aws_apigatewayv2_api.this.id
}

output "issuer" {
  description = "AUTH_JWT_ISSUER as set on the service: https://<domain>, or the default endpoint without one. What every consumer's verifier configures as the issuer; the JWKS is at <issuer>/.well-known/jwks.json."
  value       = local.issuer
}

output "domain_target" {
  description = "With a domain: the regional endpoint to alias the domain's DNS record to (Route 53 alias target name and zone id). Null without one."
  value = var.domain == null ? null : {
    name    = aws_apigatewayv2_domain_name.this[0].domain_name_configuration[0].target_domain_name
    zone_id = aws_apigatewayv2_domain_name.this[0].domain_name_configuration[0].hosted_zone_id
  }
}

output "service_function_name" {
  value = aws_lambda_function.service.function_name
}

output "backup_function_name" {
  value = aws_lambda_function.backup.function_name
}

output "relay_function_name" {
  value = aws_lambda_function.relay.function_name
}

output "backup_bucket_name" {
  value = aws_s3_bucket.backup.bucket
}

output "backup_prefix" {
  value = trimsuffix(var.backup_prefix, "/")
}
