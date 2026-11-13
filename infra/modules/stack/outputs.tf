output "url" {
  description = "Public HTTPS address of the app."
  value       = "https://${aws_cloudfront_distribution.main.domain_name}"
}

output "deploy" {
  description = "Everything the deploy workflow needs (no secrets)."
  value = {
    role_arn            = aws_iam_role.deploy.arn
    repository_url      = aws_ecr_repository.app.repository_url
    cluster             = aws_ecs_cluster.main.name
    service             = aws_ecs_service.app.name
    app_family          = aws_ecs_task_definition.app.family
    migrate_family      = aws_ecs_task_definition.migrate.family
    subnets             = join(",", aws_subnet.public[*].id)
    app_security_group  = aws_security_group.app.id
    database_identifier = aws_db_instance.main.identifier
  }
}

# For tests: the security-relevant settings, without sensitive attributes.

output "database" {
  description = "Security settings of the database."
  value = {
    publicly_accessible                 = aws_db_instance.main.publicly_accessible
    storage_encrypted                   = aws_db_instance.main.storage_encrypted
    iam_database_authentication_enabled = aws_db_instance.main.iam_database_authentication_enabled
    manage_master_user_password         = aws_db_instance.main.manage_master_user_password
    backup_retention_period             = aws_db_instance.main.backup_retention_period
  }
}

output "registry" {
  description = "Security settings of the image registry."
  value = {
    image_tag_mutability         = aws_ecr_repository.app.image_tag_mutability
    image_scanning_configuration = aws_ecr_repository.app.image_scanning_configuration
  }
}

output "ingress_rules" {
  description = "Every inbound security group rule."
  value = [for rule in [
    aws_vpc_security_group_ingress_rule.alb_from_cloudfront,
    aws_vpc_security_group_ingress_rule.app_from_alb,
    aws_vpc_security_group_ingress_rule.db_from_app,
  ] : { cidr_ipv4 = rule.cidr_ipv4 }]
}

output "cdn_viewer_protocol_policy" {
  description = "How CloudFront treats plain HTTP viewers."
  value       = aws_cloudfront_distribution.main.default_cache_behavior[0].viewer_protocol_policy
}

output "deploy_role_subject" {
  description = "The only GitHub OIDC subject the deploy role trusts."
  value       = local.deploy_subject
}
