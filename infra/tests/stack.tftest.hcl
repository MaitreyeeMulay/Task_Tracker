# Plan-only tests for the live stack (M6), with a mocked AWS provider:
# no credentials, nothing created.

mock_provider "aws" {
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{}" }
  }
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }
  mock_data "aws_region" {
    defaults = { region = "eu-west-2" }
  }
  mock_data "aws_ec2_managed_prefix_list" {
    defaults = { id = "pl-0123456789abcdef0" }
  }
  mock_resource "aws_db_instance" {
    defaults = { master_user_secret = [{ secret_arn = "arn:aws:secretsmanager:eu-west-2:123456789012:secret:rds!db-abc", kms_key_id = "", secret_status = "active" }], resource_id = "db-ABCDEFGHIJKL" }
  }
  mock_resource "aws_iam_openid_connect_provider" {
    defaults = { arn = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com" }
  }
}

variables {
  budget_alert_email = "alerts@example.test"
}

run "nothing_but_the_budget_exists_when_not_live" {
  command = plan

  assert {
    condition     = length(module.stack) == 0
    error_message = "the live stack must not exist unless live = true"
  }
}

run "database_is_private_encrypted_and_uses_iam_auth" {
  command = plan

  variables {
    live = true
  }

  assert {
    condition     = module.stack[0].database.publicly_accessible == false
    error_message = "the database must not be public"
  }

  assert {
    condition     = module.stack[0].database.storage_encrypted && module.stack[0].database.iam_database_authentication_enabled
    error_message = "the database must be encrypted and use IAM authentication"
  }

  assert {
    condition     = module.stack[0].database.manage_master_user_password == true
    error_message = "the master password must be managed (and rotated) by RDS, never set in Terraform"
  }

  assert {
    condition     = module.stack[0].database.backup_retention_period >= 1
    error_message = "backups are needed for the restore drill"
  }
}

run "nothing_accepts_traffic_from_the_whole_internet" {
  command = plan

  variables {
    live = true
  }

  assert {
    condition     = alltrue([for rule in module.stack[0].ingress_rules : rule.cidr_ipv4 == null])
    error_message = "no security group may allow inbound traffic from a CIDR range; use security groups or the CloudFront prefix list"
  }
}

run "images_are_immutable_and_scanned" {
  command = plan

  variables {
    live = true
  }

  assert {
    condition     = module.stack[0].registry.image_tag_mutability == "IMMUTABLE"
    error_message = "image tags must be immutable, so a signed digest can't be swapped"
  }

  assert {
    condition     = module.stack[0].registry.image_scanning_configuration[0].scan_on_push
    error_message = "images must be scanned on push"
  }
}

run "viewers_must_use_https" {
  command = plan

  variables {
    live = true
  }

  assert {
    condition     = module.stack[0].cdn_viewer_protocol_policy == "redirect-to-https"
    error_message = "CloudFront must redirect HTTP to HTTPS"
  }
}

run "github_can_assume_the_deploy_role_only_from_the_production_environment" {
  command = plan

  variables {
    live = true
  }

  assert {
    condition     = module.stack[0].deploy_role_subject == "repo:MaitreyeeMulay/Task_Tracker:environment:production"
    error_message = "the deploy role must trust only the production environment of this repository"
  }
}
