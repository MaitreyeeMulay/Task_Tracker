# Postgres 17 on the smallest instance, private, encrypted, TLS-only, with
# IAM authentication. RDS creates and rotates the master password in Secrets
# Manager; only the migration task reads it (docs/security-decisions.md).

resource "aws_db_subnet_group" "main" {
  name       = var.name
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_db_parameter_group" "main" {
  name   = var.name
  family = "postgres17"

  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }

  parameter {
    name  = "log_statement"
    value = "ddl"
  }

  parameter {
    name  = "log_min_duration_statement"
    value = "1000"
  }
}

resource "aws_db_instance" "main" {
  #checkov:skip=CKV_AWS_157:Single-AZ for a few-hour demo window within a $1 budget (docs/security-decisions.md)
  #checkov:skip=CKV_AWS_293:The stack is destroyed after the demo window; deletion protection would block that
  #checkov:skip=CKV_AWS_118:Enhanced monitoring adds cost; standard CloudWatch metrics and alarms cover the demo
  #checkov:skip=CKV_AWS_353:Performance Insights is not needed for a few-hour demo window
  #checkov:skip=CKV_AWS_354:Performance Insights is off (see CKV_AWS_353)
  identifier     = var.name
  engine         = "postgres"
  engine_version = "17"
  instance_class = "db.t4g.micro"

  allocated_storage = 20
  storage_type      = "gp3"
  storage_encrypted = true

  db_name                             = "incident_tracker"
  username                            = "tracker_owner"
  manage_master_user_password         = true
  iam_database_authentication_enabled = true

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.db.id]
  parameter_group_name   = aws_db_parameter_group.main.name
  publicly_accessible    = false

  backup_retention_period         = 1
  copy_tags_to_snapshot           = true
  skip_final_snapshot             = true
  deletion_protection             = false
  auto_minor_version_upgrade      = true
  apply_immediately               = true
  enabled_cloudwatch_logs_exports = ["postgresql"]
}
